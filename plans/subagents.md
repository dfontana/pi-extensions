# Durable Process-Based Subagents

Status: exploration specification

## 1. Summary

Build a small Pi extension that combines the process boundary of [`elpapi42/pi-fork`](https://github.com/elpapi42/pi-fork) with the delegation UX and orchestration concepts of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

This is a synthesis, not a direct merge: use pi-fork as the mechanical ancestor, tintinweb as the UX/configuration donor, and add a durable RPC ownership layer that neither project currently has.

Each subagent runs as a separate `pi --mode rpc` process with a normal persisted Pi session. The child process is owned by the parent Pi process and may be stopped when the parent closes. Durability means that accepted messages, tool results, usage, and session metadata are stored on disk and can be inspected or resumed after interruption; it does **not** mean that children must survive the parent process.

The extension keeps the familiar tools:

- `Agent` — start a foreground or background subagent
- `get_subagent_result` — fetch status or the final result by agent ID
- `resume_subagent` — continue a persisted subagent session
- `steer_subagent` — redirect a currently running child
- `stop_subagent` — abort a running child

The TUI remains compact:

- one-line inline tool cards
- an above-editor widget for active agents
- a footer status containing active/queued counts
- a selectable agent list
- no embedded conversation viewer; completed sessions open in a real Pi process in a kitty, Zellij, or tmux split

## 2. Goals

1. Persist every subagent as a standard Pi JSONL session.
2. Make agent IDs, session IDs, session files, status, and result-consumption state recoverable when the parent session is resumed.
3. Resume interrupted work by starting a new Pi process against the existing child session.
4. Obtain cumulative token and monetary cost from Pi's session statistics rather than maintaining a parallel approximation.
5. Preserve thinking-level, tool, MCP, and custom-agent selection while choosing models dynamically by intelligence tier.
6. Support an exact model override for users or callers that require a specific provider/model.
7. Show enough live state to understand what agents are doing without a large permanent UI.
8. Prevent subagents from recursively spawning more subagents.
9. Avoid turn limits; rely on cancellation, idle detection, context handling, and explicit resume instead.

## 3. Non-goals

The first version will not provide:

- children that continue running after the parent Pi process exits
- reattachment to an orphaned process's stdin/stdout
- a broker or background daemon
- concurrent writable access to one Pi session
- scheduling
- persistent agent memory beyond the Pi session itself
- cross-extension spawning RPC
- grouped completion batching
- automatic worktree creation or merging
- an embedded clone of Pi's conversation TUI
- automatic retries that can mutate the repository without parent approval

Worktree isolation may be added later, but mutating agents initially share the parent's working directory and are subject to the concurrency policy in section 13.

## 4. Combining pi-fork and tintinweb/pi-subagents

The two projects are complementary, but their implementations cannot simply be merged. pi-fork owns a separate disposable Pi process and serializes the parent's active branch into it; tintinweb owns an in-process SDK `AgentSession` and layers a manager, queue, tools, and rich TUI around that object. The proposed extension keeps the process boundary but replaces both ownership models with a persisted RPC child and a branch-reconstructable parent registry.

| Concern | pi-fork | tintinweb | Combined extension |
|---|---|---|---|
| Runtime | Separate one-shot `pi --mode json` process | In-process SDK session | Separate long-lived `pi --mode rpc` process |
| Initial context | Exact header + active branch snapshot | Fresh, system-prompt append, or conversation-as-text | Per-agent policy; exact snapshot only when inheritance is requested |
| Child session | Temporary JSONL, deleted after run | In-memory by default; optionally persisted | Normal Pi session, always persisted |
| Public agent record | None | In-memory manager record | Persisted transition record in parent session |
| Background queue | None | Manager, queue, grouping | Adapt manager/queue concepts to RPC records |
| Resume/steer | None | Live object only | New process against saved session; RPC steer/abort |
| Process isolation | Strong | Shared extension process | Strong; explicit child extensions/tools |
| UX | Strong foreground card and cost status | Widget, footer, FleetView, transcript overlay, menus | Compact cards/widget/footer/list; external Pi split for transcript |
| Cost | Live provider usage and nested-fork aggregation | Lifetime token accumulator | Child `get_session_stats`, cumulative and per-run delta |
| Worktrees/schedules/memory | None | Implemented | Deferred |

### What can be adapted

From pi-fork:

- executable discovery, argument-array spawning, environment construction, abort propagation, process cleanup, and streaming activity parsing patterns
- active-branch snapshot serialization for agents that explicitly inherit parent context
- cost/status rendering ideas and retry visibility

From tintinweb:

- agent discovery/frontmatter precedence and built-in agent definitions
- tool/extension exclusion policy, manager/queue semantics, completion-notification deduplication, and settings merging
- inline renderer, bounded widget, footer status, selectable fleet/list, and command/menu scaffolding

These are donors rather than drop-in modules. pi-fork's parser targets JSON print mode and deletes its session; tintinweb's UI and manager directly retain `AgentSession` objects. Both need adapters around durable records and RPC state.

### Net-new work

The material difference this extension makes across both projects is concentrated in six subsystems:

1. an RPC client with command correlation, LF-only JSONL framing, handshake validation, event dispatch, and `agent_settled` completion
2. a versioned, branch-aware parent registry reconstructed from custom session entries
3. durable recovery, resume, result consumption, and single-writer ownership reconciliation
4. read-only versus mutating concurrency locks and idle-state reporting
5. safe external split handoff and Zellij/tmux/kitty adapters
6. shared intelligence-tier model selection, exact model validation, trust checks, and extension-path allowlisting

Relative to pi-fork, almost all background orchestration, durability, and fleet UX is new. Relative to tintinweb, most visible UX concepts remain, but the runner, manager storage, resume path, completion path, model resolver, and session-coupled UI plumbing are replaced. The result is therefore closer to **pi-fork mechanically** and **tintinweb experientially**, with the durable registry/RPC layer being the principal net-new contribution.

## 5. High-level architecture

```text
Parent Pi session
  └─ subagents extension
       ├─ Agent registry (memory, reconstructed from parent session)
       ├─ concurrency queue
       ├─ one RPC client per running child
       ├─ compact widget and agent-list UI
       └─ terminal split adapter
             ├─ kitty
             ├─ zellij
             └─ tmux

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

Conceptual invocation:

```text
pi
  --mode rpc
  --session-id <session-id>
  --name "subagent:<type>:<description>"
  --thinking <level>
  --tools <allowlist>
  --no-extensions
  -e <approved-extension-path> ...
```

After startup, the parent sends exact RPC `set_model(provider, modelId)` and `set_thinking_level` commands, then verifies the resulting values with `get_state`. The initial task is sent with the RPC `prompt` command only after that state and the session ID/file are confirmed. A background `Agent` call does not return success until this handshake completes, ensuring the parent immediately receives a valid durable session reference.

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
2. `<cwd>/.agents/agents/<name>.md`
3. `$PI_CODING_AGENT_DIR/agents/<name>.md`, normally `~/.pi/agent/agents/<name>.md`

Higher entries override lower entries. Project-controlled definitions load only for trusted projects.

Suggested frontmatter:

```yaml
---
description: Fast read-only exploration
display_name: Explore
intelligence: haiku/luna
thinking: low
tools: read, grep, find, ls, bash
extensions: [mcp]
run_in_background: true
max_concurrency_group: readonly
---

You are a fast codebase exploration agent...
```

Supported fields for the MVP:

- `description`
- `display_name`
- `intelligence`
- `model` (optional exact override)
- `thinking`
- `tools`
- `extensions`
- `run_in_background`
- `enabled`

The body is the agent-specific system prompt. Prompt behavior defaults to replacement for specialist agents. A built-in `General` definition may append to the parent's system prompt, but full parent conversation inheritance is deferred unless clearly needed.

Built-in definitions:

- `General` — general coding work, `sonnet/terra` by default
- `Explore` — fast read-only repository exploration, `haiku/luna` by default
- `Research` — read-only research with approved MCP/web tools, `sonnet/terra` by default
- `Plan` — read-only implementation planning, `sonnet/terra` by default

Agent definitions select an intelligence tier rather than hardcoding a provider model. A definition may still set `model` when its behavior depends on one exact model.

## 8. Intelligence-tier model selection

Model selection happens in the parent and produces an exact canonical `provider/model-id` before the child starts. The child must never independently fuzzy-resolve a model.

### Public request shape and precedence

An `Agent` call may request either `intelligence` or `model`, not both:

```ts
type IntelligenceTier = "haiku/luna" | "sonnet/terra" | "opus/sol";

type ModelRequest =
  | { model: string; intelligence?: never }
  | { intelligence: IntelligenceTier; model?: never }
  | {};
```

Resolution precedence is:

1. call-site `model` exact override
2. call-site `intelligence`
3. definition `model` exact override
4. definition `intelligence`
5. built-in agent's default tier

`model` accepts an exact `provider/model-id`, a bare exact model ID only when it uniquely identifies one available model, or strict compatibility syntax containing an explicit family and version such as `sonnet 4.5`. Version syntax may normalize punctuation and known release suffixes, but it must resolve to that requested version; it never falls through to a newer or different version. Missing, ambiguous, or unauthenticated specific requests fail clearly. This preserves convenient specific-model requests without allowing silent substitution.

`intelligence` describes a capability tier rather than a vendor:

| Tier | Recognized families | Typical use |
|---|---|---|
| `haiku/luna` | Haiku-family, Luna-family, and explicitly mapped peers | cheap/fast exploration and mechanical lookups |
| `sonnet/terra` | Sonnet-family, Terra-family, and explicitly mapped peers | normal implementation, research, and planning |
| `opus/sol` | Opus-family, Sol-family, and explicitly mapped peers | difficult architecture, synthesis, and review |

Do not infer tiers from loose substrings in arbitrary model names. Keep an explicit, tested family-to-tier table with optional configuration for additional providers.

### Shared intelligence selector

Refactor `extensions/review-model-selector` so its tier table and deterministic candidate ordering live in a reusable module. The subagents extension calls that programmatic API directly; it does not ask the parent LLM to invoke `select_review_model` and does not expose the selector tool to children.

The shared selector must add target-tier selection because the current review selector is relative to the parent model (`same` or `higher`) and cannot ask for a lower Explore tier. It must also support Pi's full thinking-level range rather than the review tool's current `medium | high | xhigh` subset. Keep `selectReviewModel()` as a review-specific adapter over the shared selector.

For a tier request:

1. start with `ctx.modelRegistry.getAvailable()` so unavailable credentials are excluded
2. retain models explicitly mapped to the requested tier
3. require support for the requested thinking level
4. apply `minimumContextWindow` or a parsed context constraint
5. rank deterministically by configured provider preference, family/version freshness, and context fit
6. return the exact canonical route

A context suffix such as `sonnet 1m` is compatibility syntax for a tier/family constraint plus `minimumContextWindow`; it does not alter a model's context window. It is dynamic within that constrained family/tier, unlike an explicit-version request such as `sonnet 4.5`, which must never resolve to a different version. New code should prefer `intelligence` plus `minimumContextWindow`, or `model` for a specific version.

Persist both intent and outcome:

```ts
modelRequest: { kind: "tier"; tier: IntelligenceTier; minimumContextWindow?: number }
  | { kind: "exact"; reference: string };
resolvedModel: { provider: string; id: string };
```

Pass the exact provider and ID through RPC `set_model` (or equivalent exact CLI arguments), set thinking explicitly, then verify both in `get_state` during the startup handshake. A resume reuses the persisted exact route for reproducibility unless the caller explicitly requests reselection or a new exact model. Dynamic reselection is therefore per new task/run, not an accidental model change midway through a run.

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
  modelRequest:
    | { kind: "tier"; tier: IntelligenceTier; minimumContextWindow?: number }
    | { kind: "exact"; reference: string };
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
- external session handoff

On `session_start`, reconstruct from `ctx.sessionManager.getBranch()` so `/tree` rewinds produce branch-correct agent membership and consumption state. Do not reconstruct from every append-only entry irrespective of the active branch.

The parent model receives `agentId`, `childSessionId`, and a concise status in tool results. Large transcripts remain in the child session and do not enter the parent context unless explicitly fetched.

## 11. Lifecycle and recovery

Statuses:

```text
queued
starting
running
completed
failed
aborted
interrupted
external
```

Definitions:

- `completed`: child emitted `agent_settled`, last assistant stop reason is normal, and final result was captured
- `failed`: terminal model/process error with no automatic continuation pending
- `aborted`: explicitly stopped by user or parent
- `interrupted`: child ownership was lost or parent shut down before normal settlement
- `external`: writable ownership was handed to a user-opened Pi split

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

Default concurrency:

- maximum four read-only/background agents
- maximum one mutating agent in the shared working tree
- foreground agents bypass the background queue only when doing so does not violate the mutating-agent lock

Determine mutating status from enabled tools (`edit`, `write`, and unrestricted `bash` are potentially mutating). Since separate processes do not share Pi's in-process file mutation queue, two mutating children must not run concurrently in one cwd unless a future worktree mode isolates them.

Hanging policy:

- no maximum turn count
- track last RPC event and last session-entry timestamp
- show `idle 2m` in the UI rather than silently treating it as progress
- configurable warning threshold, default two minutes
- configurable hard timeout disabled by default
- user can steer, stop, or resume from the agent list
- transient provider failures remain visible through Pi's retry events
- do not automatically retry mutating work after an ambiguous process failure

## 14. Cost accounting

After settlement, `get_session_stats` is the authoritative available source for child-session usage and cost. Pi aggregates assistant-message usage across all session entries, including history removed from active context by compaction and entries on abandoned branches.

Store:

- cumulative child-session cost
- cumulative input/output/cache-read/cache-write tokens
- context-window usage
- optional run delta calculated from the baseline captured before resume

Caveats must be represented honestly:

- an interrupted streaming response may not contain final provider usage
- compaction or branch-summary helper calls may not have separately persisted usage
- provider usage or pricing metadata may be absent
- subscription pricing may not correspond to nominal per-token cost

The extension should expose `costSource` and `costComplete` when these cases can be detected.

Emit lifecycle events for integration with `extensions/improved-footer`:

```text
process-subagents:started
process-subagents:completed
process-subagents:cost
```

The cost event should carry `agentId`, child session identifiers, cumulative cost, run delta, and the parent entry ID used to anchor the cost. Improved Footer can then persist branch-accurate spend without depending on tintinweb's in-process manager symbol.

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

Use Pi's normal tool expansion key for details. Expanded output shows identifiers, prompt, final result preview, token usage, cost, and child session path. It does not render the full conversation.

### Above-editor widget

Show active and queued agents only, one line each. Remove terminal agents after a short linger period. Keep the widget bounded; if more agents exist, show `… +N more`.

### Footer

Publish a normal extension status rather than replacing the footer:

```text
agents: 2 running, 1 queued
```

This composes with Improved Footer and other status-producing extensions.

### Agent list

Register `/agents` and a configurable shortcut. The list includes agents associated with the active parent-session branch and supports:

- arrows: select
- Enter: open/take over session in a split
- `r`: resume interrupted/completed session with a prompt
- `s`: steer running agent
- `x`: stop running agent with confirmation
- `f`: fetch/mark result consumed
- `c`: copy child session ID/path
- Escape: close

The list displays type, description, state, model, elapsed time, context usage, cost, and short ID.

## 16. External split session viewer

The external viewer deliberately uses Pi's real interactive session UI instead of reimplementing transcript rendering.

### Safety rule

A Pi session must have only one writable owner. The extension must never launch `pi --session <child>` while the RPC child is still writing that session.

Behavior:

- `completed`, `failed`, `aborted`, or `interrupted`: open the child session directly
- `running`: Enter presents a choice:
  1. **Take over in split** — abort and settle the RPC child, mark the record `external`, then open the same session in Pi
  2. **Cancel** — leave the child running

A future read-only viewer could avoid handoff, but Pi currently has no built-in read-only interactive session mode. Opening a second writable Pi process against an active JSONL file is explicitly unsupported.

Conceptual launched command:

```text
pi --session <absolute-session-file>
```

The new Pi process uses the child session's cwd. It may load the user's normal Pi configuration. Set an environment marker such as `PI_SUBAGENT_EXTERNAL=1` so this extension can suppress redundant parent-agent UI if it is discovered in the external process.

When the split process exits, the parent:

1. reparses the child session
2. refreshes cumulative cost/result/leaf ID
3. marks the record completed or interrupted based on the latest session state
4. does not automatically restart autonomous work

The user may explicitly resume it afterward.

### Split adapters

Auto-detection priority is configurable; default:

1. Zellij when `$ZELLIJ` is set
2. tmux when `$TMUX` is set
3. kitty when `$KITTY_WINDOW_ID` is set and remote control works
4. configured command template
5. error notification containing a copyable `pi --session ...` command

Adapters use argument arrays, never interpolated shell strings.

Representative commands:

```text
zellij action new-pane --cwd <cwd> -- pi --session <file>
tmux split-window -h -c <cwd> pi --session <file>
kitty @ launch --type=window --location=hsplit --cwd <cwd> pi --session <file>
```

Exact kitty behavior depends on the user's remote-control configuration. The adapter must probe support and fail cleanly rather than assuming it is enabled.

Configuration:

```json
{
  "viewer": {
    "backend": "auto",
    "splitDirection": "horizontal",
    "customCommand": null
  }
}
```

## 17. Settings

Suggested global/project-merged settings:

```json
{
  "maxConcurrentReadOnly": 4,
  "maxConcurrentMutating": 1,
  "idleWarningMs": 120000,
  "hardTimeoutMs": null,
  "widgetMaxRows": 4,
  "completedLingerMs": 5000,
  "defaultBackground": false,
  "projectAgents": "trusted-only",
  "modelSelection": {
    "providerPreference": [],
    "additionalTierMappings": {}
  },
  "viewer": {
    "backend": "auto",
    "splitDirection": "horizontal"
  }
}
```

Agent frontmatter controls agent defaults; tool-call parameters control per-run overrides; project settings override global extension settings.

## 18. Error handling

Curated errors are required for:

- unknown agent type
- unavailable model or requested context size
- missing model credentials
- invalid cwd
- untrusted project agent or extension
- unavailable requested tool/extension
- child startup or RPC framing failure
- session file not created during handshake
- duplicate writable session ownership
- split backend unavailable
- process exit before `agent_settled`
- stale or invalid agent/session ID

A process exit before normal settlement produces `interrupted` unless a persisted assistant error clearly establishes `failed`.

## 19. Implementation phases

### Phase 1: durable core

- custom-agent discovery
- shared intelligence-tier selector and exact model override resolution
- RPC process client
- persistent child sessions
- parent registry entries and reconstruction
- foreground/background `Agent`
- `get_subagent_result`, resume, steer, and stop
- basic concurrency and shutdown
- session-stat cost capture

### Phase 2: compact UI

- one-line renderers
- active-agent widget
- footer status
- selectable `/agents` list
- idle indicators and completion deduplication

### Phase 3: split handoff

- Zellij adapter
- tmux adapter
- kitty adapter
- safe running-agent takeover
- exit reconciliation
- manual command fallback

### Phase 4: integration and hardening

- Improved Footer lifecycle/cost events
- MCP allowlisting
- project trust checks
- malformed RPC/session recovery tests
- tier, thinking-level, context-window, exact-version, ambiguity, and resume-model tests
- context-aware compatibility aliases such as `sonnet 1m`
- optional task-sensitive automatic tier recommendation beyond definition/caller defaults
- optional worktree isolation

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
10. Opening a running agent in an external split first transfers writable ownership; two Pi processes never write the same child session concurrently.
11. Zellij, tmux, and kitty failures produce a usable fallback command rather than losing the session.
12. Two mutating agents cannot run concurrently in the same cwd without explicit future isolation support.
13. A tier request dynamically selects an available model from the correct Haiku/Luna, Sonnet/Terra, or Opus/Sol tier and persists the exact route used.
14. An exact model override either launches that exact available provider/model or fails without substitution.
15. Resuming uses the persisted exact model unless the caller explicitly requests reselection.

## 21. Deferred decisions

Before implementation, confirm:

1. Whether `Enter` on a running agent should immediately perform safe takeover or first show the two-option confirmation.
2. Whether `.agents/agents/` compatibility belongs in the MVP or only `.pi/agents/` plus global agents.
3. Whether `General` should inherit the full parent system prompt or use a standalone prompt.
4. Which MCP extension names/paths should be approved by default.
5. Whether external Pi sessions should load all normal user extensions or a reduced explicit set.
6. Whether `/reload` should abort children in the MVP or preserve process handles through a global registry.
7. Whether user configuration may extend only provider preference within the three tiers or also add new family-to-tier mappings.
8. Whether omission of both `model` and `intelligence` should always use the agent definition default or permit a future task classifier to recommend a tier.
