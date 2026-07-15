# Durable Process-Based Subagents

Status: implementation-ready specification

## 1. Product contract

Build a Pi extension for durable delegation. Every run owns a separate
`pi --mode rpc` process and a normal persisted Pi JSONL session. Children stop
with the parent; durability means accepted prompts, completed messages, tool
results, usage, and session references survive interruption and can be resumed.

Version 1 is one release, delivered in slices. It includes:

- Markdown agent definitions and four built-ins;
- exact resolved model/thinking routes;
- foreground/background start and resume;
- branch-scoped parent records, recovery, results, stop, and cumulative cost;
- one global concurrency cap with no queue;
- one-line Agent cards, a running-only activity widget, and a view-only `/agents`
  picker with an embedded read-only transcript viewer;
- normal child extension discovery, including configured MCP/web extensions;
- project trust and malformed process/session handling; and
- migration of this repo's subagent-dependent skills to capability-based tools.

Minimum supported Pi version: **0.80.6**.

## 2. Deliberate limits

Version 1 has no daemon, scheduling, queue, steering, terminal splits,
multiplexer integration, interactive takeover/ejection, fleet dashboard, footer
status, runtime agent/settings management, parent-context inheritance, arbitrary
child cwd, worktrees, mutation classifier/lock, process retry, intelligence-tier
inference, or task-sensitive model selection.

All children share the parent cwd. Multiple mutating children may run up to the
global cap. `Explore`, `Research`, and `Plan` are prompt-level read-only roles,
not sandboxes: they may receive unrestricted `bash`, and MCP may mutate external
state. External processes opening the same child session or working tree are out
of scope.

## 3. Public tool contract

Expose exactly four model-facing tools.

### `Agent`

```ts
type AgentInput = {
  prompt: string;
  description: string;       // short UI label
  subagent_type: string;     // loaded definition ID
  model?: string;            // configured alias or Pi model reference
  thinking?: ThinkingLevel;
  run_in_background?: boolean;
};
```

A foreground call waits for settlement and cleanup, returns the full terminal
result, and consumes it. A background call returns `agentId`, `runId`, child
session ID/path, and `running` only after configuration is verified and the
initial user prompt is durable.

Background precedence is call, definition, then `defaultBackground`.

### `resume_subagent`

```ts
type ResumeSubagentInput = {
  agent_id: string;
  prompt: string;              // required new instruction
  model?: string;
  thinking?: ThinkingLevel;
  run_in_background?: boolean; // default false
};
```

Resume is legal from `completed`, `failed`, `aborted`, or `interrupted` when a
valid child session exists. It is rejected while `starting`/`running`; a startup
failure with no child session requires a new `Agent` call. Resume keeps the agent
and session IDs, creates a new run ID, and resets per-run consumption and
notification state. It reuses persisted launch configuration unless model or
thinking is explicitly overridden. Foreground/background behavior matches
`Agent`.

### `get_subagent_result`

```ts
type GetSubagentResultInput = {
  agent_id: string;
  wait?: boolean; // default false
};
```

The tool addresses the latest run. Without `wait`, return current status
immediately and include terminal data when available. With `wait`, block without
a hard timeout until terminal. Cancelling the wait unregisters it without
consuming, leaves the child running, and makes a later passive completion note
eligible again. Terminal fetches are idempotent and consume the result. An active
waiter at settlement suppresses the passive note.

### `stop_subagent`

Stop the latest running run: RPC abort, bounded flush grace, then process-tree
termination if needed. Explicit stop yields `aborted`. Stopping a terminal agent
is idempotent; unknown IDs fail.

Cancelling an `Agent`/`resume_subagent` tool call during startup or foreground
execution follows the same terminate-and-record-`aborted` path; it never detaches
the child into background. Serialize terminal transitions per run: abort wins if
its intent was recorded before settlement commits, otherwise the already
committed terminal state wins.

### Terminal result

```ts
{
  agentId: string;
  runId: string;
  status: "completed" | "failed" | "aborted" | "interrupted";
  childSessionId: string;
  childSessionFile?: string; // absent only on early startup failure
  result?: string;
  stopReason?: string;
  error?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: ContextUsage;
}
```

## 4. Agents, tools, and configuration

### Definitions

Load, lowest to highest precedence:

1. built-ins;
2. `getAgentDir()/agents/<name>.md`;
3. trusted `<cwd>/.pi/agents/<name>.md`.

A higher definition with the same ID replaces the lower one. Loaded definitions
remain available until normal `/reload`; there is no runtime toggle/removal UI.
Supported frontmatter is limited to `description`, `display_name`, `model`,
`thinking`, `tools`, and `run_in_background`. The Markdown body is a standalone
child system prompt.

Pi still supplies normal cwd/tool metadata, trusted project context files, and
skills. The extension never copies the parent's system prompt or conversation.
Persist the selected body and tool allowlist on first launch so later definition
edits do not alter resume behavior.

Built-ins:

| ID | Display | Default tools |
|---|---|---|
| `general-purpose` | General | Parent active tools except delegation tools |
| `Explore` | Explore | `read,grep,find,ls,bash` |
| `Research` | Research | Parent active tools except `edit`, `write`, and delegation tools |
| `Plan` | Plan | `read,grep,find,ls,bash` |

If `tools` is omitted, inherit only parent-active tools whose `sourceInfo` proves
they are child-discoverable: built-ins or normally discovered trusted
user/project/package extensions. Exclude SDK-only and temporary `-e` sources, as
well as `Agent`, `get_subagent_result`, `resume_subagent`, `stop_subagent`, and
`steer_subagent`. Explicit definitions are validated by the same rule; missing or
parent-only tools fail before spawn. A private child-manifest handshake then
reports the child's effective active tools and must exactly match the allowlist
before the task prompt is sent.

### Static config

Merge `getAgentDir()/subagents.json`, then trusted
`<cwd>/.pi/subagents.json`; project values win and `modelAliases` merges by key.
There is no config UI.

```json
{
  "maxConcurrentAgents": 4,
  "idleWarningMs": 120000,
  "widgetMaxRows": 4,
  "defaultBackground": false,
  "modelAliases": { "fast": "provider/model-id" }
}
```

Invalid files fail with their path. Agent tools reject an ephemeral parent
(`--no-session`) because branch ownership and recovery would be undefined.

### Model and thinking

New-run model precedence: call, definition, parent. Substitute a matching alias,
then require either canonical `provider/model-id` or a unique exact bare model ID
from `ctx.modelRegistry.getAvailable()`. Do not use fuzzy matching or synthesize a
missing model. Call `getApiKeyAndHeaders()` before spawn to validate/refresh real
auth, but never persist or expose credentials. Persist request source plus exact
`{provider,id}` outcome.

New-run thinking precedence: call, definition, parent. Resume uses explicit
overrides or the previous exact route. Unsupported thinking fails rather than
silently clamping. RPC state plus the child manifest must confirm session, model,
thinking, trust, cwd, and effective tools before prompting.

## 5. Process and lifecycle contract

### Ownership and launch

Use `child_process.spawn()` with argument arrays and `shell: false`. New runs use
`--session-id`; resumes use the absolute `--session` file. Pass exact provider,
model, thinking, tools, persisted system prompt, parent cwd/environment, and
`--approve`/`--no-approve` matching `ctx.isProjectTrusted()`.

Let children perform normal Pi extension discovery. Set a private child marker;
under it, the main extension registers no delegation tools or UI. Explicitly load
a bundled child-guard entrypoint with repeated singular `--extension`; it exposes
only a private manifest command that appends cwd, trust, model/thinking, and
active-tool names as a child custom entry. The parent invokes and validates this
command before the task prompt. Temporary parent-only `-e` extensions need not
carry over. Other extension code/config is rediscovered, but in-memory state is
fresh: notably, MCP servers begin disabled, so a child must inspect MCP status
and connect what it needs.

A thin RPC owner is justified because exported `RpcClient` does not expose PID or
process-exit notification. Implement only the needed subset:

- strict LF JSONL framing, request correlation, typed errors, and stderr capture;
- streaming message/tool events and `agent_settled`;
- process exit/error, PID, and process-tree stop;
- prompt, abort, state, last-assistant-text, session-stats, and viewer snapshots;
- RPC extension-UI responses: cancel blocking select/confirm/input/editor
  requests, and acknowledge fire-and-forget UI as no-op so headless children
  cannot hang waiting for a parent TUI.

Background acceptance requires: spawn; verify RPC state; invoke and verify the
private manifest; send the task prompt; observe its user message in durable child
entries; persist `running`; return IDs. Pi RPC exits when stdin closes, so abrupt
parent death closes the ownership channel. Graceful shutdown still aborts and
terminates explicitly. PID is diagnostic, never recovery authority.

### States and settlement

```text
starting -> running -> completed | failed | aborted | interrupted
```

- `completed`: `agent_settled` and final assistant is non-error; preserve other
  stop reasons such as token limit.
- `failed`: startup/session/provider failure or settled assistant error.
- `aborted`: explicit stop or tree-away cancellation.
- `interrupted`: reload, parent shutdown, or process loss before settlement.

On normal settlement: fetch final text/state/stats; persist terminal state; close
the child immediately; update UI; and resolve foreground/waiting calls. For an
unconsumed background run with no active waiter, persist
`notificationPending: true`; do **not** use Pi's runtime-global `nextTurn` queue.
At the next `before_agent_start`, collect only pending completions whose run
origins are visible on the active branch, persist them delivered, and inject one
visible custom message summarizing them into that parent turn. This is passive—it
never creates a turn—and branch-safe. Persisting delivery first favors a missed
note over duplication on crash. Pending/delivered notification and result
consumption are separate per-run state; consuming before delivery clears pending.

A process exit before `agent_settled` is `interrupted` unless persisted entries
prove a terminal assistant error. Explicit stop intent wins as `aborted`. The
extension never restarts or replays automatically.

`get_session_stats` is authoritative for cumulative child-session tokens, cost,
and context usage. Per-run deltas are out of scope. Document missing usage on
interrupted streams, compaction/pricing gaps, and subscription-billing caveats.

### Concurrency and shutdown

One global cap covers `starting` and `running`; default four. There is no queue.
Over-cap errors list active IDs. Runs have no hard timeout or turn limit. Track
last RPC activity and display idle age after `idleWarningMs`. Child Pi retains
normal provider retry/compaction; this extension does not retry processes.

Graceful shutdown/reload/tree cancellation: RPC abort, bounded session flush,
close stdin/SIGTERM, then process-tree termination. `/reload` records
`interrupted`; `/new`, `/resume`, and `/fork` tear down the old runtime and stop
its children.

## 6. Durable parent state and branches

Persist non-context **full run snapshots** under `process-subagents:v1`. Recovery
takes the latest valid snapshot for each `(agentId,runId)`; no event reducer or
in-place mutation is needed. Append only creation, handshake, terminal,
consumption, notification, and resume snapshots.

Required snapshot fields:

```ts
type PersistedRunSnapshot = {
  version: 1;
  agentId: string;
  runId: string;
  runNumber: number;
  agentOriginEntryId: string;
  runOriginEntryId: string;
  parentSessionId: string;
  childSessionId: string;
  childSessionFile?: string;
  type: string;
  displayName: string;
  description: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  tools: string[];
  modelRequest: { reference?: string; source: "call" | "definition" | "parent" | "resume" };
  resolvedModel: { provider: string; id: string };
  thinking: ThinkingLevel;
  background: boolean;
  status: AgentStatus;
  startedAt: string;
  completedAt?: string;
  lastActivityAt?: string;
  resultConsumed: boolean;
  notificationPending: boolean;
  notificationSent: boolean;
  resultPreview?: string;
  stopReason?: string;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
  contextUsage?: ContextUsage;
};
```

Full results and streaming state stay in memory/child JSONL; parent snapshots
store a bounded preview. Terminal fetches reconstruct full text from the child.

An agent is visible on branches containing `agentOriginEntryId`; each active run
belongs to `runOriginEntryId`. In a tool execution, locate the persisted assistant
session entry whose tool-call content contains the current `toolCallId`; that
entry is the run origin, and the first run's entry is also the agent origin. Fail
before spawn if it cannot be found. This remains stable under parallel tool
execution and does not depend on `appendEntry()` returning an ID or on the mutable
leaf. Reconstruct only from `ctx.sessionManager.getBranch()`.

In `session_before_tree`, inspect the destination path. Continue a run only if its
run origin remains; otherwise abort and persist `tree-navigation` before moving,
with a bounded wait. Before every async run-transition append, recheck that run
origin is active. If a race loses the branch, do not contaminate the new branch;
retain child/in-memory outcome and reconcile when its branch returns.

At session start, safely parse each visible nonterminal run without a live handle:
settled non-error result -> `completed`; final assistant error -> `failed`;
otherwise -> `interrupted`. Never reattach by PID or start a writer automatically.
Malformed/missing child sessions remain visible as curated failures and must not
crash startup.

## 7. TUI contract

### Inline cards and widget

Collapsed Agent/resume cards are one visual line:

```text
⠹ Explore[Haiku 200k] Find auth files · grep src/auth
✓ Explore[Haiku 200k] Find auth files · $0.013 · 12s
✗ General[Sonnet 1M] Refactor auth · interrupted
```

Key cards by `(agentId,runId)` so old resume cards stay stable. Background cards
subscribe to registry updates after their tool call returns. Expanded cards show
IDs, prompt, exact launch config, status, preview, usage/cost, and session path—not
the transcript.

The above-editor widget shows running runs only, up to `widgetMaxRows`, with idle
age and a short latest assistant/tool preview; show `… +N more` if needed and
remove terminal rows immediately. No footer status.

### `/agents`

Bare `/agents` is a transient, view-only selector for branch-visible agents.
Show status, type, short ID, and description. Enter opens the transcript; Escape
returns to normal UI. It has no resume, stop, fetch, copy, eject, remove, settings,
or other management actions and requires no shortcut. Viewer Escape also returns
directly to normal UI.

### Read-only transcript viewer

Use `ctx.ui.custom()` and Pi's exported message/session components. Durable view:
parse JSONL, build the child active branch, and reproduce Pi's public
message-to-component pattern. Standard messages and built-in tools use Pi-native
rendering. Custom extension tools/messages use generic fallback because their
renderer definitions are not exposed to the parent; exact visual parity is not a
requirement.

For a running child, combine durable context with cached RPC
`message_update`/`tool_execution_update` state. Re-read durable context on final
message/tool events and remove matching transient overlays; render once from disk
after settlement. Do not poll or watch the file.

Open at bottom, follow only while already at bottom, and support arrows,
PgUp/PgDn, Home/End, Escape, and the normal tool-expansion key. Initial expansion
matches the parent's current setting. The viewer never writes or disturbs the
child.

## 8. Implementation slices

All slices are required for version 1.

1. **Contracts:** config/definition/trust loaders, built-ins, tool schemas,
   exact model/auth and child-discoverable tool resolution, run snapshots, and Pi
   minimum update.
2. **Durable core:** RPC owner/child manifest/UI cancellation, launch handshake,
   four tools, settlement/stats,
   cap, passive notes, stop/shutdown/reload, tree cancellation, and recovery.
3. **TUI:** live one-line cards, running widget, view-only picker, terminal/live
   viewer, scrolling/follow, and custom-render fallback.
4. **Integration:** normal extension discovery, fresh MCP state, recursion guard,
   trust/malformed cases, full tests/typecheck, and manual RPC/TUI smoke tests.

Also update `skills/run-review` and `skills/run-plan`: remove unused steer and
package-specific preflights; prefer `resume_subagent`, with
`Agent(resume: ...)` fallback for another compatible provider.

Tests must protect observable plugin/process/UI contracts rather than private
construction. Cover definition/config precedence, model auth/ambiguity, thinking
mismatch, tool provenance/manifest mismatch, strict JSONL, RPC UI cancellation,
durable acceptance, settlement/abort races, retry, early exit or malformed
children, idempotent fetch/stop, waiter cancellation, resume, cap, branch-safe
passive-note dedupe, reload, branch rewinds/races, startup reconciliation, and viewer
fallback/live behavior. Run `npm test` and `npm run typecheck`.

## 9. Acceptance criteria

Version 1 is complete when:

1. Background start/resume returns IDs only after durable acceptance; foreground
   returns and consumes full terminal data.
2. Same-session resume keeps agent ID and creates a new stable run ID from every
   valid terminal status.
3. Reload/restart reconstructs branch-visible state without old objects or PID
   reattachment and safely reconciles stale runs.
4. Tree navigation continues only runs present on the destination path, cancels
   tree-away runs, and never writes transitions onto unrelated branches.
5. Result fetch defaults immediate, optionally waits, is idempotent, and does not
   stop a child when the wait is cancelled.
6. Background completion creates at most one branch-safe passive note in a later
   parent turn, never an automatic turn, and no note for an active waiter.
7. Foreground/background cancellation terminates rather than detaches; serialized
   settlement/abort races produce one terminal state and bounded cleanup.
8. Exact authenticated model, thinking, cwd, trust, prompt, and effective tools
   are verified before useful work; parent-only/missing tools fail before spawn.
9. Children rediscover normal extensions with fresh state but cannot recursively
   call this extension's delegation tools.
10. The global cap rejects instead of queueing; no mutation-safety guarantee is
    implied.
11. Cumulative usage/cost matches child session stats subject to documented
    provider caveats.
12. Cards stay one line, old run cards stay stable, and the widget shows only live
    progress/preview.
13. `/agents` remains a view-only picker, not a fleet/settings/management screen.
14. The viewer opens running/terminal children without disturbance and renders
    live Pi-native standard content with documented custom-render fallback.
15. `run-plan`/`run-review` work without steer and can use dedicated or compatible
    Agent-based resume.

## Appendix A: launch details and errors

Conceptual new-run invocation (resume replaces `--session-id` with `--session`):

```text
pi --mode rpc
  --session-id <uuid>
  --name "subagent:<type>:<description>"
  --provider <provider>
  --model <model-id>
  --thinking <level>
  --tools <allowlist>
  --system-prompt <persisted-body>
  --extension <bundled-child-guard>
  --approve | --no-approve
```

Curate errors for invalid/untrusted config or definitions; ephemeral parent;
unknown agent/ID; unavailable/parent-only tools; exact model/auth/thinking failure;
cap; invalid resume status; spawn/exit/stderr/framing/UI/response/manifest mismatch;
non-durable prompt; missing/malformed child session; branch race; and failed
termination. Never expose credentials, environment secrets, or full system
prompts in model-visible errors.

## Appendix B: simplifications and ancestry

Principal simplifications from exploration:

- one cap instead of read-only/mutating classification and locking;
- normal extension discovery plus recursion/tool filtering instead of extension
  allowlists;
- no parent snapshots/context modes, arbitrary cwd, fleet/footer/settings/
  takeover UI, process-global reload registry, PID recovery, viewer polling, or
  Improved Footer/per-run-cost integration;
- full run snapshots instead of an event reducer; and
- one dedicated resume tool with explicit skill compatibility fallback.

Mechanical ancestry: pi-fork for process ownership/cleanup; tintinweb
pi-subagents for definitions, tool UX, compact rendering, and notification ideas;
Pi itself for sessions, model resolution, RPC events, statistics, trust,
lifecycle, themes, message components, and custom UI hosting. Net-new work stays
concentrated in process ownership, branch-scoped recovery, compact subscriptions,
and the read-only transcript adapter.
