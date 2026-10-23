# Subagent

Delegate tasks to global, user-defined agents running in their own Pi processes.

There are two modes, both built on Pi's RPC mode (`pi --mode rpc`):

- **Normal:** each `subagent` call runs one task in a disposable child and returns its complete result. Independent work runs in parallel when the parent emits sibling `subagent` calls in the same assistant response.
- **Vibe (`/vibe`):** the parent becomes a director. `subagent` starts a persistent worker and returns its id immediately. Results arrive on their own, and `subagent_send` steers or continues a worker. See [Vibe mode](#vibe-mode).

Both modes use global agent definitions only, with per-call model, thinking, and working-directory overrides resolved through the shared model-query registry. There are no chains, workflow prompts, worktrees, or nested delegation.

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

The working directory defaults to the dispatching session's current directory. Explicit model values are resolved against Pi's refreshed authenticated registry, limited to the session's scoped models when scoping is configured. Canonical provider/model references and Pi-style short/fuzzy names are accepted; unavailable, ambiguous, or synthetic models fail only their native row. A `:thinking` suffix remains compatible, and an explicit call `thinking` wins over that suffix.

To run independent work in parallel, emit all independent sibling `subagent` calls in the same assistant response, up to eight calls. Do not issue unrelated sequential tools between those calls. Then consume every complete synchronous result before continuing. Each native Pi tool row remains separate, and Ctrl+O remains Pi's global expansion toggle.

Older persisted calls containing the removed array syntax are display-only compatibility cases. Reissue those tasks as sibling calls; the live tool does not execute the old format.

## Scheduling and execution

Each extension instance has a FIFO scheduler with at most eight outstanding/admitted calls and four active child processes. An accepted call immediately emits a queued partial result, so its native row shows `·` and `waiting for subagent slot`; a launched call shows `●` and `working`; completion shows `✓`, and child failure or cancellation shows `✗`. Setup and model resolution may finish while a call waits, but only child launch consumes an active slot. Aborted waiters are removed and never launched. Every admission and active lease is released idempotently in `finally`, including runner and setup errors. The scheduler is scoped to the parent extension instance/session and is not shared across processes.

Each call launches Pi in RPC mode with no session file and sends `Task: <task>` as its one prompt; the child is stopped (stdin closed, then TERM and KILL if it lingers) as soon as that turn settles. Extension dialogs inside the child are answered as cancelled. Explicit parent `--no-extensions` and `--extension` flags are preserved, with extension paths made absolute so a working-directory override cannot change what is loaded. Immediately before launch, registered environment providers add values to that child's isolated environment. The child receives `PI_EXTENSIONS_SUBAGENT_CHILD=1`, preventing recursive registration. Visible child activity streams into compact rendering; transcript messages, stderr, and the latest full tool-call preview are separately bounded. Model-visible final output is capped at 50 KB per call; retained details are also separately bounded, while per-call usage remains available.

The model registry refresh is shared as a single-flight operation across simultaneous sibling calls. Individual callers still honor their own cancellation, and each requested model is resolved independently after refresh, so one invalid model does not invalidate its siblings.

Child failures return their retained, separately bounded result details and usage and are marked as native Pi tool errors. Setup, schema, admission, and model-resolution failures throw normally. Aborting a queued or admitted-but-not-started call cancels it without launching a child. An active child receives TERM first, then KILL after the five-second grace period if it remains alive.

## Vibe mode

`/vibe` (TUI only, while the parent is idle; no arguments) toggles director mode. While it is on:

- The parent can only use `read`, `todo`, `subagent`, and the four worker controls. Any other tool call, including one nested inside another tool, is blocked, and `!`/`!!` shell commands are rejected. A system prompt section explains the director role.
- The input box border turns the theme's accent color with ` VIBE ` at its top left. This works with or without [helix-mode](../helix-mode/README.md); the status bar shows the worker count and a widget lists each worker's state and latest activity.
- `subagent` (same parameters as normal mode) starts a worker and returns `Started worker w1-general (turn t1)` right away.
- `subagent_send {workerId, message}` reaches a busy worker at its next step, after its current tool batch and before its next model call, like typing into a running Pi. An idle or parked worker starts a new turn. Messages arrive as `<director-message id=…>` blocks.
- When a worker's turn ends, its final text (capped at 16 KiB), status, and usage are posted to the director as a message, which starts a director turn if it was idle. If a `subagent_wait {workerIds?, timeoutMs?}` is pending for that worker, the wait returns the result instead. A wait with nothing running returns at once; the default timeout is 30 s, up to 120 s.
- `subagent_list` shows every worker's state, turns, activity, usage, and transcript path. `subagent_kill {workerId}` stops a worker for good, ending any turn in progress.

Workers share the parent's filesystem; nothing isolates their edits from each other. Up to eight worker processes run at once, and worker turns share the four active-turn slots with normal calls. A spawn at the limit parks the least recently used idle worker, and is rejected if all are busy. A parked worker's process is stopped; the next `subagent_send` relaunches it on its saved transcript.

Each worker keeps its own Pi session under `~/.pi/agent/subagent-workers/<parent session id>/`, next to a `workers.json` roster. Switching, forking, starting a new session, `/tree`, reload, and quit park every worker. After a restart, running `/vibe` again lists the saved workers as parked, and `subagent_send` resumes one only after checking that its transcript file and session id still match. Nothing is replayed automatically: a turn cut off by shutdown stays interrupted, and the worker continues from its transcript when sent a message. Turning vibe off kills every worker and deletes the roster; transcripts are left on disk.

Worker usage appears per worker and in each result message; it is not added to the parent session's totals. Idle workers turn off Pi's prompt-cache warming so they do not spend while waiting.

## Rendering

Rows use the shared compact tool row (`extensions/shared/tool-row.ts`). Collapsed, a row is a single title line—`subagent <state> <agent> <model> <thinking> (<usage>)`—truncated with `...` rather than wrapped; usage updates live while the child runs. The state icon is `·` while queued, a spinner while running, and `✓`/`✗` once settled, and the requested agent, model, and thinking stay visible even when the call fails. Expanding wraps the full title and begins directly with the working directory and task, then renders final Markdown only after completion, or the error and process diagnostics on failure. While running, expanded rows reserve exactly ten lines for only the latest tool call (or ten blank lines before the first call), showing its full name and arguments and then wrapping and clipping the preview to the available ten lines; queued rows do not reserve activity space. Completion, failure, and cancellation remove that activity area, so no historical tool calls remain in completed output. Stored `mode=single` details use the current renderer; stored `mode=parallel` details are rendered only from their persisted `content` fallback and are never treated as a structured batch.

## Reused Pi APIs

The implementation uses public Pi APIs for config-directory discovery, frontmatter parsing, extension context defaults, context-token calculation, Markdown rendering, tool-result middleware, and tool-result usage. Stateless usage-formatting helpers are shared locally with the improved-footer extension; process and rendering helpers remain small and local to this extension.
