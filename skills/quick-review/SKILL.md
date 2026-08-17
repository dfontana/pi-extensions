---
name: quick-review
description: >
  Run a lightweight single-agent code review and bounded fix/re-review loop for small, routine, low-risk, or clearly scoped changes. Use by default for ordinary review requests that do not explicitly request a deep, comprehensive, adversarial, or multi-agent audit. One reviewer checks completeness, correctness, duplication, and simplicity together.
compatibility: Requires Pi 0.84.1+ and the subagent tool.
---

# Quick Review

Coordinate a focused review of a concrete code target. Preserve the target resolution, model selection, evidence standards, fix loop, and reporting of the full review workflow while using one reviewer per standard round.

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
- `fixer=subagent` — delegate fixes to a fresh general-purpose subagent.
- `requirements=<text>` — the intended behavior, consolidated feedback, or implementation plan to check for completeness.

These internal fields are workflow context, not required user-facing syntax.

## 1. Preflight and resolve the target

Confirm that `subagent` is available. If it is missing, stop and tell the user to enable or reload this package.

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

Pass the tool's exact `selectedModel` and `thinking` values to every reviewer call. Tell the user which model was selected, why, and whether higher intelligence was unavailable according to the tool's `notice` field.

The selector is mandatory because it reads the live session model and configured model registry. If the tool is unavailable, stop and tell the user to enable or reload this package; do not guess from settings or model names in Markdown.

## 3. Run one review round

Read [references/reviewer-prompt.md](references/reviewer-prompt.md) in full and fill every placeholder with the exact scope, base, requirements, and prior-round context.

Launch exactly one fresh, read-only reviewer for the standard round with `subagent` using the selected model and thinking level. Consume its complete synchronous result before continuing.

The reviewer must independently inspect the actual repository and cover all four angles in one pass:

1. **Completeness** — omitted or partial requirements, plan steps, tests, docs, migrations, error paths, integrations, and user-visible behavior.
2. **Correctness** — logic bugs, invalid assumptions, edge cases, regressions, unsafe behavior, security, concurrency/state, API contracts, and inadequate tests.
3. **Duplication** — existing helpers, abstractions, behavior, and tests elsewhere in the repository that the change duplicates or should consolidate.
4. **Simplicity** — unnecessary abstraction, indirection, branching, configuration, scope, or a materially simpler correct design; no subjective style feedback.

Do not launch separate angle investigators or a synthesis reviewer. The single reviewer must assume the code is wrong, verify findings directly, and return only evidence-backed findings with file/line references or exactly `CLEAN`.

If a reviewer response violates the `CLEAN`/`CHANGES_REQUIRED` contract, allow one fresh corrective reviewer for that round with the same complete context. If it is still invalid, stop and report the protocol failure. Never retry without a bound.

## 4. Run the bounded fix loop

There are at most three reviews. The third review is report-only.

1. **Review 1**
   - Run the single-reviewer round above.
   - If `CLEAN`, stop.
   - Otherwise deliver every validated finding to the fixer.
   - With `fixer=coordinator`, apply the fixes in this session.
   - With `fixer=subagent`, launch a fresh general-purpose subagent with the requirements, current target, and validated findings, then consume its complete result.
   - Run focused tests/checks for the fixes. Do not claim success if they fail.
2. **Review 2**
   - Recompute the target and launch one fresh reviewer.
   - If `CLEAN`, stop.
   - Otherwise use the same fixer, then run focused tests/checks again.
3. **Review 3 — final verification**
   - Recompute the target and launch one fresh reviewer.
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
