---
name: run-plan
description: >
  Consolidate code-review feedback into a cohesive implementation plan, delegate implementation to a Claude Sonnet 4.6 1M subagent, then invoke the reusable adversarial run-review workflow with a subagent as the fixer. Use when the user provides review feedback to plan, implement, and repeatedly verify.
compatibility: Requires Pi 0.84.1+ and the subagent tool.
---

# Run Plan

Coordinate planning, delegated implementation, and adversarial review. You are the coordinator: research and plan, but never write code yourself.

## Inputs and preflight

Read all review feedback and user instructions before acting. If the feedback is missing, ask for it. Additional user instructions take precedence over defaults and may specify:

- `scope`, `model`, and `thinking=medium|high|xhigh` for `run-review` (`model` always means the reviewer model);
- `implementation_model` for the implementing agent;
- `implementation_minimum_context_window` for that model (default `1000000`).

Confirm that `subagent` is available. If not, stop and tell the user to enable or reload this package. Also require the `select_review_model` tool from this package.

## 1. Consolidate feedback

Inspect the relevant repository context and turn the individual comments into one cohesive plan:

- merge overlapping comments and identify common root causes;
- resolve contradictions or ask the user when a real decision is required;
- identify affected files, call sites, tests, docs, migrations, and compatibility constraints;
- order changes so the implementation remains coherent;
- preserve traceability from every original comment to a plan item.

Do not implement the plan in the coordinating session.

## 2. Resolve and delegate the implementation model

The default implementation model is `anthropic/claude-sonnet-4-6` (a 1M-context Claude Sonnet route). Use this exact route unless the user supplies an `implementation_model` override. If the default route is not available in the session's model registry, stop and ask the user which model to use rather than silently substituting another. `implementation_minimum_context_window` (default `1000000`) is the minimum context window required; confirm the resolved route meets it before proceeding.

Launch one general-purpose implementing agent with `subagent` using the exact selected model. Its prompt must contain:

- the complete consolidated feedback;
- the implementation plan;
- relevant repository and version-control instructions;
- acceptance criteria and required tests;
- an explicit designation that this is the workflow's implementation/fixer agent.

In a Jujutsu repository, that designation permits working-copy file edits under the `jujutsu` skill's narrow implementer exception; it never permits the subagent to run mutating `jj` commands.

Consume its complete synchronous result. Verify the actual repository changes and test results; do not trust the implementation summary alone. Do not edit code yourself.

## 3. Invoke run-review

Read the sibling skill [../run-review/SKILL.md](../run-review/SKILL.md) in full and follow it as the authoritative review protocol. Pass this internal context:

- `scope`: the user's explicit review scope, otherwise current working changes;
- `model`: the user's explicit reviewer model, if any;
- `thinking`: the user's explicit value, otherwise `high`;
- `fixer=subagent`;
- `requirements`: the original feedback plus the consolidated implementation plan.

The default fixer in `run-review` is the coordinating session; overriding it with a fresh general-purpose subagent is mandatory here. Include the original requirements, consolidated plan, current target, and validated findings in each fixer task. The coordinator must not make review fixes.

`run-review` owns reviewer-model selection, the adversarial four-angle review, round limits, test expectations, and final reporting. Do not duplicate or weaken those rules here.

## 4. Final response

Return the concise outcome required by `run-review`, plus a traceability summary showing how the consolidated plan addressed each original review comment. Clearly surface unresolved final-review findings or failed checks.
