# Subagent

Delegate one task at a time to global, user-defined agents in isolated Pi processes.

This extension intentionally keeps a small synchronous surface:

- one `subagent` tool invocation launches exactly one child process
- independent work runs in parallel when the parent emits sibling `subagent` calls in the same assistant response
- global agent definitions only
- per-call model, thinking, and working-directory overrides
- shared model-query registry resolution
- no chains, workflow prompts, background handles, steering, worktrees, or nested delegation

## Agent definitions

Create non-recursive Markdown files in:

```text
~/.pi/agent/agents/*.md
```

The actual root comes from Pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` is respected. Project-local `.pi/agents` directories are never read.

```markdown
---
name: scout
description: Quickly explore a codebase
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: low
---

Explore the requested area. Return concise findings with file paths.
```

Required frontmatter:

- `name`: unique agent name
- `description`: short description shown in the tool definition

A built-in `General` worker definition is always available and is used when a call requests an unknown agent name. A global agent named `General` overrides that built-in definition.

Optional frontmatter:

- `tools`: comma-separated Pi tool names; omitted means Pi's normal defaults
- `model`: any model reference accepted by Pi's `--model` CLI option
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

The Markdown body is appended to the child Pi system prompt. Invalid files are skipped and reported as warnings when the tool is invoked. Agent files are rediscovered for each invocation, so edits do not require restarting Pi.

## Tool API

```json
{
  "agent": "scout",
  "task": "Find the authentication entry points",
  "cwd": "/path/to/project",
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "high"
}
```

`agent` and `task` are required. `cwd`, `model`, and `thinking` are optional. The precedence for each call is:

1. call override
2. agent frontmatter
3. dispatching session defaults

The working directory defaults to the dispatching session's current directory. Explicit model values are resolved against Pi's refreshed authenticated registry. Canonical provider/model references and Pi-style short/fuzzy names are accepted; unavailable, ambiguous, or synthetic models fail only their native row. A `:thinking` suffix remains compatible, and an explicit call `thinking` wins over that suffix.

To run independent work in parallel, emit all independent sibling `subagent` calls in the same assistant response, up to eight calls. Do not issue unrelated sequential tools between those calls. Then consume every complete synchronous result before continuing. Each native Pi tool row remains separate, and Ctrl+O remains Pi's global expansion toggle.

Older persisted calls containing the removed array syntax are display-only compatibility cases. Reissue those tasks as sibling calls; the live tool does not execute the old format.

## Scheduling and execution

Each extension instance has a FIFO scheduler with at most eight outstanding/admitted calls and four active child processes. An accepted call immediately emits a queued partial result, so its native row shows `·` and `waiting for subagent slot`; a launched call shows `●` and `working`; completion shows `✓`, and child failure or cancellation shows `✗`. Setup and model resolution may finish while a call waits, but only child launch consumes an active slot. Aborted waiters are removed and never launched. Every admission and active lease is released idempotently in `finally`, including runner and setup errors. The scheduler is scoped to the parent extension instance/session and is not shared across processes.

Each call launches Pi in JSON print mode with no session file. Explicit parent `--no-extensions` and `--extension` flags are preserved, with extension paths made absolute so a working-directory override cannot change what is loaded. Immediately before launch, registered environment providers add values to that child's isolated environment. The child receives `PI_EXTENSIONS_SUBAGENT_CHILD=1`, preventing recursive registration. Visible child activity streams into compact rendering; transcript messages, stderr, and the latest full tool-call preview are separately bounded. Model-visible final output is capped at 50 KB per call; retained details are also separately bounded, while per-call usage remains available.

The model registry refresh is shared as a single-flight operation across simultaneous sibling calls. Individual callers still honor their own cancellation, and each requested model is resolved independently after refresh, so one invalid model does not invalidate its siblings.

Child failures return their retained, separately bounded result details and usage and are marked as native Pi tool errors. Setup, schema, admission, and model-resolution failures throw normally. Aborting a queued or admitted-but-not-started call cancels it without launching a child. An active child receives TERM first, then KILL after the five-second grace period if it remains alive.

## Rendering

Collapsed rows show per-call usage, a truncated prompt, and the latest final response or error; their rendering is unchanged by expanded activity. Expanded rows begin directly with the working directory and task—the native title already shows agent, model, thinking, and state—and render final Markdown only after completion. While running, expanded rows reserve exactly ten lines for only the latest tool call (or ten blank lines before the first call), showing its full name and arguments and then wrapping and clipping the preview to the available ten lines; queued rows do not reserve activity space. Completion, failure, and cancellation remove that activity area, so no historical tool calls remain in completed output. Stored `mode=single` details use the current renderer; stored `mode=parallel` details are rendered only from their persisted `content` fallback and are never treated as a structured batch.

## Reused Pi APIs

The implementation uses public Pi APIs for config-directory discovery, frontmatter parsing, extension context defaults, context-token calculation, Markdown rendering, tool-result middleware, and tool-result usage. Stateless usage-formatting helpers are shared locally with the improved-footer extension; process and rendering helpers remain small and local to this extension.
