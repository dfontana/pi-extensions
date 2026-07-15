# Process Subagents

Durable delegation through separate `pi --mode rpc` processes. Each agent has a normal persisted Pi JSONL session and can be resumed after a terminal run. Child processes stop with the owning parent session; completed messages, tool results, session references, and cumulative usage remain on disk.

Requires Pi **0.80.6+**.

## Tools

- `Agent` — start a loaded agent definition, in the foreground or background.
- `resume_subagent` — continue a terminal agent in the same child session with a new run ID.
- `get_subagent_result` — inspect immediately or wait until terminal; terminal reads are idempotent.
- `stop_subagent` — abort and terminate the latest running run.

Background starts return only after the exact task envelope is present in the child session file. Foreground calls wait for cleanup and consume the terminal result. Cancelling a start/resume call terminates the child rather than detaching it.

`/agents` opens a view-only branch-scoped picker and read-only child transcript. Agent/resume tool calls use compact one-line cards. A widget above the editor shows running agents only.

## Agent definitions

Definitions are Markdown files named `<id>.md`, loaded in this order:

1. bundled `general-purpose`, `Explore`, `Research`, and `Plan` definitions;
2. `~/.pi/agent/agents/*.md` (or the configured Pi agent directory);
3. trusted `<cwd>/.pi/agents/*.md`.

A higher-precedence file with the same ID replaces the lower definition. The body is the child's standalone system prompt. Supported frontmatter:

```markdown
---
description: Locate authentication code
display_name: Auth Explorer
model: fast
thinking: high
tools: read, grep, find, ls, bash
run_in_background: true
---
Inspect the repository without editing it. Return concrete paths and evidence.
```

Only those six keys are accepted. The chosen prompt and tools are persisted on first launch, so later definition edits do not change resume behavior.

Built-in role tool defaults:

| ID | Display | Tools |
|---|---|---|
| `general-purpose` | General | Child-discoverable parent-active tools except delegation |
| `Explore` | Explore | `read, grep, find, ls, bash` |
| `Research` | Research | Inherited tools except `edit`, `write`, and delegation |
| `Plan` | Plan | `read, grep, find, ls, bash` |

These roles are prompt-level policies, not OS sandboxes. `bash` and MCP tools may still mutate state.

## Configuration

Global configuration is `~/.pi/agent/subagents.json`; trusted projects can override it at `<cwd>/.pi/subagents.json`:

```json
{
  "maxConcurrentAgents": 4,
  "idleWarningMs": 120000,
  "widgetMaxRows": 4,
  "defaultBackground": false,
  "modelAliases": {
    "fast": "provider/model-id"
  }
}
```

Project values win, while `modelAliases` merge by key. Invalid or unknown values fail with the source path. There is one global concurrency cap and no queue.

Model references are exact: `provider/model-id`, a configured alias, or a unique exact bare model ID. Authentication is validated before spawn. Unsupported thinking levels fail instead of being clamped.

## Tool and extension discovery

Children perform normal Pi extension discovery in the parent's cwd and trust mode. Only parent-active tools with child-discoverable provenance can be passed through; SDK-only and temporary `-e` tools are rejected. A private child handshake verifies session, cwd, trust, exact model/thinking, and effective tool names before useful work begins.

The extension disables its own delegation tools inside children, preventing recursive `Agent` calls. Other extensions start with fresh in-memory state. For example, MCP servers are not inherited as live connections and may need to be connected by the child.

## Durability and branches

Parent run snapshots are non-context entries stored as `process-subagents:v1`. Agents are visible only on branches containing their first call; each resumed run belongs to its own call entry. Tree navigation stops runs that are absent from the destination branch. Reload/startup never reattaches by PID: it reconciles visible stale runs from child JSONL as completed, failed, interrupted, or a curated malformed-session failure.

Unconsumed background completions are injected at most once as a visible custom message at the next parent turn on the originating branch. They never create a turn by themselves. Fetching the result clears any pending note.

## Limits and accounting

- All children share the parent cwd and environment.
- No daemon, queue, scheduler, steering, worktree, mutation lock, process retry, takeover, or arbitrary child cwd.
- External processes opening the same child session/worktree are unsupported.
- Running transcripts combine durable entries with a short live activity overlay. Built-in tools and standard messages use Pi-native components; custom extension tools/messages use generic fallback because child renderers are not exported.
- Session statistics are cumulative across all runs in a child session. Interrupted streams, compaction/pricing gaps, and subscription billing can leave usage or cost incomplete.
- Parent runtime-only credentials that are not available through inherited environment, persisted auth, or rediscovered provider configuration may validate in the parent but still fail child startup.
- The initial task is wrapped in a neutral `Delegated task` envelope so slash-command expansion cannot reinterpret it; startup fails if another extension transforms the durable message.
