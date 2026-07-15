# Durable Process-Based Subagents

Status: exploration specification (simplified)

## 1. Summary

Build a small Pi extension that combines the process boundary of [`elpapi42/pi-fork`](https://github.com/elpapi42/pi-fork) with the delegation UX of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

This is a synthesis, not a direct merge: use pi-fork as the mechanical ancestor, tintinweb as the UX/configuration donor, and add a durable RPC ownership layer that neither project currently has. The guiding constraint is **dumb-simple reliability**: fewer subsystems, fewer states, and maximum reuse of what Pi already exports.

Each subagent runs as a separate `pi --mode rpc` process with a normal persisted Pi session. The child process is owned by the parent Pi process and may be stopped when the parent closes. Durability means that accepted messages, tool results, usage, and session metadata are stored on disk and can be inspected or resumed after interruption; it does **not** mean that children must survive the parent process.

The extension keeps a small tool surface:

- `Agent` — start a foreground or background subagent
- `get_subagent_result` — fetch status or the final result by agent ID
- `resume_subagent` — continue a persisted subagent session
- `stop_subagent` — abort a running child

The TUI remains compact:

- one-line inline tool cards
- an above-editor widget for active agents
- a footer status containing the active count
- a selectable agent list
- an **embedded read-only session viewer** built from Pi's own exported message components, so a subagent transcript reads exactly like a normal Pi session (minus editor, footer, and slash commands)

There is no terminal-split subsystem. Pi exports the exact components its interactive mode uses to render sessions (`AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, and the rest), plus `SessionManager`/`parseSessionEntries` for loading a child JSONL and `ctx.ui.custom()` for showing a focused full-screen component. Because the viewer is read-only, it works on **running** agents too — no ownership handoff, no multiplexer adapters, no takeover state machine. For users who want to drive a child session interactively, the extension stops the child and prints a copyable `pi --session <file>` command.

## 2. Goals

1. Persist every subagent as a standard Pi JSONL session.
2. Make agent IDs, session IDs, session files, status, and result-consumption state recoverable when the parent session is resumed.
3. Resume interrupted work by starting a new Pi process against the existing child session.
4. Obtain cumulative token and monetary cost from Pi's session statistics rather than maintaining a parallel approximation.
5. Preserve thinking-level, tool, MCP, and custom-agent selection, with exact model references resolved through Pi's own model resolver.
6. Show enough live state to understand what agents are doing without a large permanent UI, including an on-demand transcript view of any agent — running or finished.
7. Prevent subagents from recursively spawning more subagents.
8. Avoid turn limits; rely on cancellation, context handling, and explicit resume instead.

## 3. Non-goals

The first version will not provide:

- children that continue running after the parent Pi process exits
- reattachment to an orphaned process's stdin/stdout
- a broker or background daemon
- concurrent writable access to one Pi session
- scheduling
- persistent agent memory beyond the Pi session itself
- cross-extension spawning RPC
- a background queue or grouped completion batching (over-cap starts fail with a clear error instead)
- a `steer_subagent` tool (stop + resume covers redirection; Pi's RPC `steer` command makes this easy to add later)
- intelligence-tier inference from model family tables (a user-edited alias map covers the convenience case)
- terminal-split viewers or multiplexer adapters (Zellij/tmux/kitty)
- a reimplementation of Pi's transcript rendering (the embedded viewer reuses Pi's exported components verbatim)
- automatic worktree creation or merging
- automatic retries that can mutate the repository without parent approval

Worktree isolation may be added later, but mutating agents initially share the parent's working directory and are subject to the mutating lock in section 13.

## 4. Combining pi-fork and tintinweb/pi-subagents

The two projects are complementary, but their implementations cannot simply be merged. pi-fork owns a separate disposable Pi process and serializes the parent's active branch into it; tintinweb owns an in-process SDK `AgentSession` and layers a manager, queue, tools, and rich TUI around that object. The proposed extension keeps the process boundary but replaces both ownership models with a persisted RPC child and a branch-reconstructable parent registry.

| Concern | pi-fork | tintinweb | Combined extension |
|---|---|---|---|
| Runtime | Separate one-shot `pi --mode json` process | In-process SDK session | Separate long-lived `pi --mode rpc` process |
| Initial context | Exact header + active branch snapshot | Fresh, system-prompt append, or conversation-as-text | Per-agent policy; exact snapshot only when inheritance is requested |
| Child session | Temporary JSONL, deleted after run | In-memory by default; optionally persisted | Normal Pi session, always persisted |
| Public agent record | None | In-memory manager record | Persisted transition record in parent session |
| Background handling | None | Manager, queue, grouping | Simple caps; over-cap starts fail with a clear error |
| Resume/steer | None | Live object only | New process against saved session; RPC stop/resume |
| Process isolation | Strong | Shared extension process | Strong; explicit child extensions/tools |
| Transcript view | None | Custom transcript overlay | Read-only viewer built from Pi's exported session components |
| Cost | Live provider usage and nested-fork aggregation | Lifetime token accumulator | Child `get_session_stats` at settlement |
| Worktrees/schedules/memory | None | Implemented | Deferred |

### What can be adapted

From pi-fork:

- executable discovery, argument-array spawning, environment construction, abort propagation, process cleanup, and streaming activity parsing patterns
- active-branch snapshot serialization for agents that explicitly inherit parent context
- cost/status rendering ideas and retry visibility

From tintinweb:

- agent discovery/frontmatter precedence and built-in agent definitions
- tool/extension exclusion policy, completion-notification deduplication, and settings merging
- inline renderer, bounded widget, footer status, selectable fleet/list, and command/menu scaffolding

From Pi itself (the biggest donor for the viewer):

- `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `CustomMessageComponent`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `SkillInvocationMessageComponent`
- `Theme`, `getMarkdownTheme`, `initTheme` for identical styling
- `SessionManager`, `parseSessionEntries`, `sessionEntryToContextMessages` for loading child sessions
- `resolveCliModel` / `ModelRegistry` for model resolution
- `ctx.ui.custom()` and pi-tui `Container`/overlay primitives for hosting the viewer

### Net-new work

The material difference this extension makes is concentrated in four subsystems:

1. an RPC client with command correlation, LF-only JSONL framing, handshake validation, event dispatch, and `agent_settled` completion
2. a versioned, branch-aware parent registry reconstructed from custom session entries
3. durable recovery, resume, result consumption, and single-writer ownership reconciliation
4. a read-only session viewer: an entries-to-components loop (~150–250 lines) over Pi's exported renderers, hosted in `ctx.ui.custom()` with scroll handling

Relative to pi-fork, the durability, registry, and fleet UX are new. Relative to tintinweb, most visible UX concepts remain, but the runner, manager storage, resume path, completion path, and session-coupled UI plumbing are replaced. The result is closer to **pi-fork mechanically** and **tintinweb experientially**, with the durable registry/RPC layer being the principal net-new contribution.

## 5. High-level architecture

```text
Parent Pi session
  └─ subagents extension
       ├─ Agent registry (memory, reconstructed from parent session)
       ├─ one RPC client per running child
       ├─ mutating-agent lock (per cwd)
       ├─ compact widget and agent-list UI
       └─ read-only session viewer (Pi's exported components in ctx.ui.custom)

Child Pi process
  ├─ exact cwd/model/thinking/tool configuration
  ├─ restricted extension set (never this extension)
  ├─ JSONL RPC over stdin/stdout
  └─ persisted Pi session under the normal session directory
```

Use `child_process.spawn()` with argument arrays and `shell: false`. Parse RPC stdout using LF-only JSONL framing, not Node's `readline`, because Pi's RPC protocol permits Unicode line separators inside JSON strings.

## 6. Child process invocation

The extension generates both IDs before spawning:

- `agentId`: short stable identifier exposed to the parent model and UI
- `sessionId`: UUID passed to Pi with `--session-id`

Model, thinking level, tools, and extensions are all passed as CLI flags at spawn time — Pi's CLI accepts `--provider`, `--model`, `--thinking`, `--session-id`, `--tools`, `--no-extensions`, and `--extensions`, so no post-spawn RPC mutation is needed:

```text
pi
  --mode rpc
  --session-id <session-id>
  --name "subagent:<type>:<description>"
  --provider <provider>
  --model <model-id>
  --thinking <level>
  --tools <allowlist>
  --no-extensions
  --extensions <approved-extension-path> ...
```

After startup, the parent performs a single `get_state` sanity check to confirm the model, thinking level, and session ID/file. The initial task is sent with the RPC `prompt` command only after that check passes. A background `Agent` call does not return success until this handshake completes, ensuring the parent immediately receives a valid durable session reference.

The child inherits the parent environment and cwd unless the invocation explicitly supplies another absolute cwd.

### Process shutdown

On parent `session_shutdown`:

1. send RPC `abort` to running children
2. wait for a bounded grace period for final session writes
3. send `SIGTERM`
4. use process-tree termination after the grace period if necessary
5. append an `interrupted` state transition to the parent session when possible

Reload may preserve child handles through a process-global registry in a later version. The MVP may abort children during `/reload`, provided their sessions remain resumable and the UI explains why they stopped.

## 7. Agent definitions

Discover Markdown definitions from:

1. `<cwd>/.pi/agents/<name>.md`
2. `$PI_CODING_AGENT_DIR/agents/<name>.md`, normally `~/.pi/agent/agents/<name>.md`

Higher entries override lower entries. Project-controlled definitions load only for trusted projects. (`.agents/agents/` compatibility is deliberately omitted.)

Suggested frontmatter:

```yaml
---
description: Fast read-only exploration
display_name: Explore
model: fast            # settings alias or exact provider/model-id; omit to use the parent's model
thinking: low
tools: read, grep, find, ls, bash
extensions: [mcp]
run_in_background: true
---

You are a fast codebase exploration agent...
```

Supported fields for the MVP:

- `description`
- `display_name`
- `model` (settings alias or exact reference; defaults to the parent's current model)
- `thinking`
- `tools`
- `extensions`
- `run_in_background`
- `enabled`

The body is the agent-specific system prompt. Prompt behavior defaults to replacement for specialist agents. A built-in `General` definition may append to the parent's system prompt, but full parent conversation inheritance is deferred unless clearly needed.

Built-in definitions:

- `General` — general coding work; parent's model by default
- `Explore` — fast read-only repository exploration; `fast` alias when configured, else parent's model
- `Research` — read-only research with approved MCP/web tools; parent's model by default
- `Plan` — read-only implementation planning; parent's model by default

## 8. Model selection

Model selection happens in the parent and produces an exact canonical `provider/model-id` before the child starts. The child must never independently fuzzy-resolve a model. There are no tier tables, family heuristics, or compatibility version syntax — resolution reuses Pi's own exported `resolveCliModel`/`ModelRegistry` and a small user-edited alias map.

### Request shape and precedence

An `Agent` call may pass an optional `model` string. Resolution precedence is:

1. call-site `model`
2. definition `model`
3. the parent session's current model

A `model` value is resolved as:

1. if it matches a key in the `modelAliases` settings map, substitute the alias target first
2. resolve the (substituted) reference with Pi's `resolveCliModel` against `ctx.modelRegistry.getAvailable()`, so unavailable credentials are excluded

Missing, ambiguous, or unauthenticated references fail with a clear error before spawning. There is no silent substitution and no fallthrough to a "close enough" model.

The alias map is plain configuration, not inference:

```json
{
  "modelAliases": {
    "fast": "some-provider/some-cheap-model",
    "smart": "some-provider/some-strong-model"
  }
}
```

Persist both intent and outcome:

```ts
modelRequest: { reference?: string; source: "call" | "definition" | "parent" };
resolvedModel: { provider: string; id: string };
```

The exact provider and ID are passed as CLI flags at spawn (section 6) and confirmed by the single `get_state` check. A resume reuses the persisted exact route for reproducibility unless the caller explicitly passes a new `model`. Task-sensitive automatic tier recommendation and richer selection logic (e.g. a shared selector with `extensions/review-model-selector`) are explicitly deferred.

## 9. Tool and extension isolation

Child processes must not discover arbitrary extensions by default. Start with `--no-extensions`, then explicitly load approved extension entrypoints.

Rules:

- the subagents extension is always excluded
- built-in tools use an exact allowlist
- MCP is opt-in through an approved extension name/path
- project extension paths require project trust
- extension names are resolved to exact paths before child launch
- unknown tool or extension names fail before spawning
- child prompts state that they cannot launch further subagents

The MVP should support the project's MCP extension because `Research` and some `General` agents need it. Loading all parent extensions is not an acceptable default because factories may have side effects and can recreate recursive delegation.

## 10. Persisted parent registry

The parent session is the authority for which subagent records belong to that conversation. Persist state with custom entries that do not enter LLM context:

```ts
type SubagentRecord = {
  version: 1;
  agentId: string;
  parentSessionId: string;
  childSessionId: string;
  childSessionFile: string;
  pid?: number;
  type: string;
  description: string;
  prompt: string;
  cwd: string;
  modelRequest: { reference?: string; source: "call" | "definition" | "parent" };
  resolvedModel: { provider: string; id: string };
  thinking: string;
  status: AgentStatus;
  startedAt: string;
  completedAt?: string;
  lastEntryId?: string;
  resultConsumed: boolean;
  resultPreview?: string;
  stopReason?: string;
  cost?: number;
};
```

Append records under a versioned custom type such as:

```text
process-subagents:v1
```

Persist only meaningful transitions, not every token or spinner frame:

- created
- started/handshake complete
- interrupted
- completed/failed/aborted
- result consumed
- resumed

On `session_start`, reconstruct from `ctx.sessionManager.getBranch()` so `/tree` rewinds produce branch-correct agent membership and consumption state. Do not reconstruct from every append-only entry irrespective of the active branch.

The parent model receives `agentId`, `childSessionId`, and a concise status in tool results. Large transcripts remain in the child session and do not enter the parent context unless explicitly fetched.

## 11. Lifecycle and recovery

Statuses:

```text
starting
running
completed
failed
aborted
interrupted
```

Definitions:

- `completed`: child emitted `agent_settled`, last assistant stop reason is normal, and final result was captured
- `failed`: terminal model/process error with no automatic continuation pending
- `aborted`: explicitly stopped by user or parent
- `interrupted`: child ownership was lost or parent shut down before normal settlement

Startup reconciliation for every nonterminal record:

1. open or parse the child session file
2. inspect its latest entries and leaf
3. never assume a stored PID is still the writer without ownership verification
4. classify an unowned unfinished session as `interrupted`
5. allow `resume_subagent` to launch a new RPC child with `--session <file-or-id>`

Resuming appends a new user prompt to the same child session. The default prompt should include the user's new instruction; it should not automatically replay the original task because the child session already contains it.

## 12. Result and completion protocol

Use Pi's `agent_settled` event as the process-level completion boundary, not merely `agent_end` or process exit.

On settlement:

1. call `get_last_assistant_text`
2. call `get_state`
3. call `get_session_stats`
4. call `get_entries` with the last durable cursor if needed
5. persist the terminal parent record
6. update inline/widget UI
7. send one follow-up completion notification to the parent agent if the run was backgrounded and unconsumed

`get_subagent_result` is idempotent. Its response includes:

```ts
{
  agentId,
  status,
  childSessionId,
  childSessionFile,
  result,
  stopReason,
  cost,
  tokens,
  contextUsage,
}
```

After a successful fetch, append `resultConsumed: true`. Completion notification code checks this state to avoid notifying twice. Calling the tool repeatedly still returns the result but does not create new parent notifications.

Use an entry ID cursor rather than message counts for incremental reads because Pi sessions are append-only trees and may compact or branch.

## 13. Concurrency, hangs, and cancellation

There is no background queue. Simple caps, enforced at start time:

- maximum four concurrent read-only agents (configurable); starting a fifth fails with a clear, actionable error the parent model can react to
- maximum one mutating agent in the shared working tree, enforced with a single per-cwd lock; a second mutating start fails with a clear error

Determine mutating status from enabled tools (`edit`, `write`, and unrestricted `bash` are potentially mutating). Since separate processes do not share Pi's in-process file mutation queue, two mutating children must not run concurrently in one cwd unless a future worktree mode isolates them.

Hanging policy:

- no maximum turn count and no hard timeout
- track last RPC event and last session-entry timestamp
- show `idle 2m` in the UI rather than silently treating it as progress
- the on-demand viewer (section 16) is the primary diagnostic: open the agent and read what it is actually doing
- user can stop or resume from the agent list
- transient provider failures remain visible through Pi's retry events
- do not automatically retry mutating work after an ambiguous process failure

## 14. Cost accounting

After settlement, `get_session_stats` is the authoritative available source for child-session usage and cost. Pi aggregates assistant-message usage across all session entries, including history removed from active context by compaction and entries on abandoned branches.

Store:

- cumulative child-session cost
- cumulative input/output/cache-read/cache-write tokens
- context-window usage

Known caveats (documented, not modeled in the MVP): an interrupted streaming response may not contain final provider usage; compaction helper calls may not have separately persisted usage; provider pricing metadata may be absent; subscription pricing may not correspond to nominal per-token cost.

Per-run deltas, `costSource`/`costComplete` flags, and lifecycle/cost events for `extensions/improved-footer` are deferred to the hardening phase.

## 15. TUI specification

### Inline card

Default rendering is one visual line:

```text
⠹ Explore[Haiku 200k] Find auth files · grep src/auth
✓ Explore[Haiku 200k] Find auth files · $0.013 · 12s
✗ General[Sonnet 1M] Refactor auth · interrupted
```

Format:

```text
{status} {Agent}[{ModelShortName} {ContextShort}] {description} · {activity/result}
```

Use Pi's normal tool expansion key for details. Expanded output shows identifiers, prompt, final result preview, token usage, cost, and child session path. It does not render the full conversation — that is the viewer's job.

### Above-editor widget

Show active agents only, one line each. Remove terminal agents after a short linger period. Keep the widget bounded; if more agents exist, show `… +N more`.

### Footer

Publish a normal extension status rather than replacing the footer:

```text
agents: 2 running
```

This composes with Improved Footer and other status-producing extensions.

### Agent list

Register `/agents` and a configurable shortcut. The list includes agents associated with the active parent-session branch and supports:

- arrows: select
- Enter: open the read-only session viewer
- `r`: resume interrupted/completed session with a prompt
- `x`: stop running agent with confirmation
- `f`: fetch/mark result consumed
- `c`: copy child session ID/path
- Escape: close

The list displays type, description, state, model, elapsed time, context usage, cost, and short ID.

## 16. Embedded read-only session viewer

The viewer renders a child session inside the parent TUI using Pi's real session-rendering components, so it reads exactly like a normal Pi session without the editor, footer, or slash commands. It never writes to the child session, so it is safe for any agent state — including running agents — and the single-writer rule is satisfied by construction.

### Building blocks (all exported by `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`)

- message components: `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `CustomMessageComponent`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `SkillInvocationMessageComponent`
- theming: `Theme`, `getMarkdownTheme`, `initTheme`
- session loading: `SessionManager`, `parseSessionEntries`, `sessionEntryToContextMessages`
- hosting: `ctx.ui.custom()` (focused full-screen component) and pi-tui `Container`

Pi's own replay function (`rebuildChatFromMessages` in `InteractiveMode`) is private, so the extension implements its own entries-to-components loop — a small switch over entry/message types (~150–250 lines), cribbing the construction patterns from Pi's interactive mode.

### Behavior

- Enter on any agent in the list opens the viewer immediately; no confirmation, no state change to the agent
- terminal agents: parse the child session file once and render the active branch
- running agents: render live; refresh via RPC `get_entries` with the last entry-ID cursor (or by re-parsing the appended JSONL file on change), appending new components as they arrive
- scrolling: the viewer owns a scroll offset over rendered lines; PgUp/PgDn/arrows/Home/End; opens scrolled to the bottom and follows output while at the bottom
- Escape closes the viewer and returns to the agent list

### Interactive takeover escape hatch

Pi has no read-only interactive session mode, and a Pi session must have only one writable owner. When the user wants to *drive* a child session interactively:

1. stop the RPC child (if running) and wait for settlement
2. print a copyable command: `pi --session <absolute-session-file>`

The user runs it wherever they like — their own splits, tabs, or windows. The extension does not manage terminal multiplexers.

## 17. Settings

Suggested global/project-merged settings:

```json
{
  "maxConcurrentReadOnly": 4,
  "idleWarningMs": 120000,
  "widgetMaxRows": 4,
  "completedLingerMs": 5000,
  "defaultBackground": false,
  "projectAgents": "trusted-only",
  "modelAliases": {}
}
```

Agent frontmatter controls agent defaults; tool-call parameters control per-run overrides; project settings override global extension settings.

## 18. Error handling

Curated errors are required for:

- unknown agent type
- unknown, ambiguous, or unauthenticated model reference or alias
- missing model credentials
- invalid cwd
- untrusted project agent or extension
- unavailable requested tool/extension
- concurrency cap or mutating lock rejection (actionable: tells the parent model what is running and what to do)
- child startup or RPC framing failure
- session file not created during handshake
- duplicate writable session ownership
- process exit before `agent_settled`
- stale or invalid agent/session ID

A process exit before normal settlement produces `interrupted` unless a persisted assistant error clearly establishes `failed`.

## 19. Implementation phases

### Phase 1: durable core

- custom-agent discovery
- alias + exact model resolution via Pi's `resolveCliModel`
- RPC process client
- persistent child sessions
- parent registry entries and reconstruction
- foreground/background `Agent`
- `get_subagent_result`, resume, and stop
- concurrency caps, mutating lock, and shutdown
- session-stat cost capture

### Phase 2: compact UI

- one-line renderers
- active-agent widget
- footer status
- selectable `/agents` list
- read-only session viewer (terminal and live agents)
- idle indicators and completion deduplication

### Phase 3: integration and hardening

- MCP allowlisting
- project trust checks
- malformed RPC/session recovery tests
- model alias, ambiguity, and resume-model tests
- Improved Footer lifecycle/cost events and per-run cost deltas
- optional worktree isolation
- optional `steer_subagent` via RPC `steer`

## 20. Acceptance criteria

1. Starting a background agent returns both an agent ID and persisted child session ID.
2. The child appears in Pi's ordinary session storage and can be opened after it stops.
3. Killing or closing the parent leaves a valid child session that can be resumed from the parent session later.
4. Resuming the parent reconstructs child records without relying on a previous Node object or PID.
5. `get_subagent_result` returns the same terminal result repeatedly but triggers at most one parent completion notification.
6. Child cost after settlement matches the child's `/session` or RPC session statistics, subject to documented provider caveats.
7. No child can call this extension's subagent tools.
8. MCP tools are available only when explicitly allowed by the agent definition.
9. The default inline card occupies one line, the widget is bounded, and footer status composes with Improved Footer.
10. The viewer renders a child transcript using Pi's exported components so it is visually identical to the same session opened in Pi, and it opens for running agents without disturbing them.
11. No second writable Pi process is ever launched against an active child session; the takeover escape hatch stops the child first and only prints a command.
12. Two mutating agents cannot run concurrently in the same cwd; the second start fails with an actionable error.
13. A model reference or alias either launches that exact available provider/model or fails without substitution.
14. Resuming uses the persisted exact model unless the caller explicitly passes a new one.
15. Starting an agent beyond the read-only cap fails with a clear error rather than queueing silently.

## 21. Deferred decisions

Before implementation, confirm:

1. Whether `General` should inherit the full parent system prompt or use a standalone prompt.
2. Which MCP extension names/paths should be approved by default.
3. Whether `/reload` should abort children in the MVP or preserve process handles through a global registry.
4. How the live viewer refreshes for running agents: RPC `get_entries` polling, session-file watching, or both.
5. Whether the viewer should honor Pi's tool-expansion toggle per component or render everything collapsed by default.

Deliberately deferred features (not open questions): `steer_subagent`, background queueing, intelligence tiers/shared model selector, terminal-split adapters, worktree isolation.
