---
name: run-review
description: >
  Run an adversarial code review and bounded fix/re-review loop over working changes, a branch, files, revisions, or another explicit target. Use when the user asks to review implementation work, audit changes from multiple angles, or independently verify a completed task. Defaults to current working changes, a deterministically selected reviewer model, high thinking, and fixes by the coordinating session.
compatibility: Requires Pi subagent start, result, and resume capabilities.
---

# Run Review

Coordinate an adversarial review of a concrete code target. Do not replace this workflow with a casual inline review.

## Invocation contract

The user's arguments are appended to this skill as a `User:` message. Extract these optional preferences:

- `scope`: what is under review. Default: current working changes.
- `intelligence`: `higher` or `same`. Default: `higher`.
- `thinking`: `medium`, `high`, or `xhigh`. Default: `high`.

Accept natural-language scopes, including:

- `working` or no scope — tracked and untracked current working changes
- `branch` or `branch base=<revision>` — the whole branch relative to its base
- `file=<path>` or an explicit list of files — complete current contents of those files, with relevant call sites
- a commit, revision range, PR URL, directory, or other clearly identified target

Reject thinking values outside `medium|high|xhigh`. Reject intelligence values outside `higher|same`.

Internal callers may also supply:

- `fixer=coordinator` — the current coordinating session applies fixes; this is the default.
- `fixer=agent:<id>` — synchronously resume that implementing agent with findings. `run-plan` uses this mode.
- `requirements=<text>` — the intended behavior, consolidated feedback, or implementation plan to check for completeness.

These internal fields are workflow context, not required user-facing syntax.

## 1. Preflight and resolve the target

Confirm that `Agent` and `get_subagent_result` are available, plus either the dedicated `resume_subagent` tool or a compatible `Agent` tool with a `resume` input. If start, result, or resume capability is missing, stop and identify the missing capability; do not degrade to a single-agent review.

Restate the exact review target. Resolve it with repository-appropriate commands and include untracked files.

- For current working changes, inspect status plus the complete working diff. In Jujutsu repositories use `jj`; never substitute raw Git commands. In Git repositories include untracked files rather than relying on `git diff` alone.
- For a branch, determine the actual comparison base from repository metadata. If the base is ambiguous, ask the user instead of guessing.
- For files or directories, review their complete current contents and relevant callers/tests, not only changed lines.
- For revisions, ranges, or PRs, verify that the requested target exists and record the exact resolved identifiers.

Keep the same logical target and base across rounds, but recompute its current contents after every fix.

## 2. Select the reviewer model

Call `select_review_model` once before the first review:

```text
select_review_model({ intelligence: <user value or "higher">, thinking: <user value or "high"> })
```

Pass the tool's exact `selectedModel` and `thinking` values to every angle investigator and reviewer call. Tell the user which model was selected, why, and whether higher intelligence was unavailable (the tool's `notice` field).

The selector is mandatory because it reads the live session model and configured model registry. If the tool is unavailable, stop and tell the user to enable/reload this package; do not guess from settings or model names in Markdown.

## 3. Run one review round

For each review round, the coordinating session—not a child reviewer—owns the parallel fan-out. Do not ask a child reviewer to launch nested agents.

### Parallel angle investigation

In one message, launch exactly four background `Agent` calls with `run_in_background=true`, the selected model, and selected thinking level. Give every agent the exact scope, base, requirements, prior findings/fixes, and repository rules. Mark every agent read-only. The four prompts must independently cover:

1. **Completeness** — omitted or partial requirements, plan steps, tests, docs, migrations, error paths, integrations, and user-visible behavior.
2. **Correctness** — logic bugs, invalid assumptions, edge cases, regressions, unsafe behavior, security, concurrency/state, API contracts, and inadequate tests.
3. **Duplication** — existing helpers, abstractions, behavior, and tests elsewhere in the repository that the change duplicates or should consolidate.
4. **Simplicity** — unnecessary abstraction, indirection, branching, configuration, scope, or a materially simpler correct design; no subjective style feedback.

Every angle prompt must say: assume the code is wrong; inspect the actual repository; return only evidence-backed findings with file/line references or `NO FINDINGS`; do not modify files.

Capture all four returned IDs. Retrieve all four complete results with `get_subagent_result(wait=true)` before continuing. Never synthesize from completion notifications or summaries.

### Adversarial synthesis

Read [references/reviewer-prompt.md](references/reviewer-prompt.md) in full. Fill every placeholder, including the four complete angle reports.

Launch a fresh synthesis reviewer for every round as a background agent with the selected model and thinking. Capture its ID and retrieve its complete result with `get_subagent_result(wait=true)`. Fresh reviewers avoid anchoring and do not depend on the subagent package's short completed-session retention window. Each reviewer remains read-only, assumes the code is wrong, independently verifies every angle report, and returns only validated findings or exactly `CLEAN`.

If a reviewer response violates the `CLEAN`/`CHANGES_REQUIRED` contract, allow one fresh corrective reviewer for that round with the same complete context. If it is still invalid, stop and report the protocol failure. Never retry without a bound.

## 4. Run the bounded fix loop

There are at most three reviews. The third review is report-only.

1. **Review 1**
   - Run the complete parallel investigation and synthesis above.
   - If `CLEAN`, stop.
   - Otherwise deliver every validated finding to the fixer.
   - With `fixer=coordinator`, apply the fixes in this session.
   - With `fixer=agent:<id>`, resume that exact ID synchronously using `resume_subagent` when available. Otherwise use the compatible provider's `Agent` resume input. Consume the terminal result directly and retain the original agent ID even though the resume creates a new run. If the child session is unavailable or cannot be resumed, stop and report the unresolved findings rather than creating a replacement.
   - Run focused tests/checks for the fixes. Do not claim success if they fail.
2. **Review 2**
   - Recompute the target, run a new four-agent parallel investigation, then launch a fresh synthesis reviewer.
   - If `CLEAN`, stop.
   - Otherwise use the same fixer, then run focused tests/checks again.
3. **Review 3 — final verification**
   - Recompute the target, run the four parallel angles, and launch a fresh synthesis reviewer.
   - Do not apply another fix round.
   - Return any remaining validated findings clearly as unresolved.

## 5. Report the outcome

Report concisely:

- resolved review target and base;
- selected reviewer model, thinking level, and selection reason;
- number of reviews and fix rounds performed;
- tests/checks run and their outcomes;
- final `CLEAN` status or unresolved third-review findings.

Never hide unresolved findings, failed checks, ambiguous scope, unavailable tools, or model-selection fallback.
