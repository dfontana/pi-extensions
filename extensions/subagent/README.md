# Subagent

Delegate tasks to global, user-defined agents in isolated Pi processes.

This extension intentionally provides a smaller surface than Pi's example and third-party subagent managers:

- one synchronous `subagent` tool
- single and bounded parallel execution only
- global agent definitions only
- per-task model, thinking, and working-directory overrides
- no chains, workflow prompts, background handles, steering, worktrees, or nested delegation

## Agent definitions

Create non-recursive Markdown files in:

```text
~/.pi/agent/agents/*.md
```

The actual root comes from Pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` is respected.
Project-local `.pi/agents` directories are never read.

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

A built-in `General` worker-style definition is always available and is used when a call requests an unknown agent name. A global agent named `General` overrides that built-in definition.

Optional frontmatter:

- `tools`: comma-separated Pi tool names; omitted means Pi's normal defaults
- `model`: any model reference accepted by Pi's `--model` CLI option
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

The Markdown body is appended to the child Pi system prompt. Invalid files are skipped and reported as warnings when the tool is invoked. Agent files are rediscovered for each invocation, so edits do not require restarting Pi.

## Tool API

Single task:

```json
{
  "agent": "scout",
  "task": "Find the authentication entry points",
  "cwd": "/path/to/project",
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "high"
}
```

Parallel tasks:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find authentication code" },
    { "agent": "scout", "task": "Find authorization tests", "thinking": "medium" }
  ]
}
```

A parallel call accepts at most eight tasks and runs at most four child processes concurrently. Each task has independent `cwd`, `model`, and `thinking` fields.

Defaults resolve independently in this order:

1. tool-call task override
2. agent frontmatter
3. dispatching session's current model or thinking level

The working directory defaults to the dispatching session's current directory.

## Execution and output

Each task launches Pi in JSON print mode with no session file. The extension streams child messages into compact tool rendering, offers expanded Markdown output, and returns aggregate child usage through Pi's tool-result usage field. Model-visible final output is capped at 50 KB per task; retained transcript details are separately bounded to prevent runaway memory use.

Parallel failures are reported alongside successful task results. A failed single task fails the tool call. Aborting the parent call sends `SIGTERM` to active children and escalates to `SIGKILL` after five seconds.

For a single call, the tool heading shows `subagent`, status, agent, model name, and thinking level on one line (without the provider prefix). The collapsed result then shows usage, truncated prompt, and the latest return value or error while hiding child tool calls. Expanded output includes every resolved call parameter, tool calls, output, and any error. Active agents use an animated throbber; completed agents use a checkmark.

The child process receives `PI_EXTENSIONS_SUBAGENT_CHILD=1`. This extension detects that marker and does not register its tool in children, preventing recursive delegation.

## Replacing another subagent extension

Disable the existing extension that owns `Agent`, `get_subagent_result`, or another `subagent` tool before enabling this one. Existing skills in this repository still target their external Agent-based extension and are not migrated by this implementation.

## Reused Pi APIs

The implementation uses public Pi APIs for config-directory discovery, frontmatter parsing, extension context defaults, Markdown rendering, and tool-result usage. Pi does not currently export public helpers for streaming child processes, aggregating nested usage, compact token/cost formatting, or summarizing arbitrary tool calls, so those helpers remain small and local to this extension.
