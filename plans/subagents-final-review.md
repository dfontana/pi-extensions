# Process Subagents — Final Review Feedback

Review status: **CHANGES_REQUIRED**

Reviewer: `openai-codex/gpt-5.6-sol` with high thinking  
Rounds: 3 total; 2 fix rounds; final round report-only

Validation before final review:

- `npm test`: 88 passed
- `npm run typecheck`: passed
- Real Pi RPC foreground start/resume integration smoke test: passed

These findings were intentionally left unresolved after the bounded final review so they can be evaluated and iterated on later.

## Findings

### R1 — High — Authentication error secrecy

- Location: `extensions/process-subagents/resolution.ts:62-63`
- Authentication failures interpolate raw `auth.error` into model-visible tool errors. Provider diagnostics or command-backed credential text may contain secrets.
- Curate authentication failures to a generic public message; retain diagnostics only internally.
- Verify bearer tokens, command credentials, URLs with credentials, and header values never appear in tool results, snapshots, notifications, or previews.

### R2 — High — Branch recovery loses snapshots

- Location: `extensions/process-subagents/persistence.ts:185-201`, `runtime.ts:197-217`
- Snapshots are appended as descendants of the current leaf, but recovery scans only the active branch. A branch containing the origin ancestry but diverging before the snapshot descendants can lose the agent after restart.
- Add an origin-indexed durable mechanism or mirror the latest snapshot onto destination branches where its origin remains visible.
- Verify start, branch, restart, result, card, and resume behavior across divergent branches.

### R3 — Medium — Settled runs can become interrupted

- Location: `extensions/process-subagents/runtime.ts:688-747`
- If `get_last_assistant_text` or `get_session_stats` fails after `agent_settled`, the run is marked `interrupted` even when the child JSONL contains a successful terminal assistant.
- Fall back to strict child-session inspection and preserve completed/failed status while leaving unavailable authoritative stats absent.
- Verify failed post-settlement RPC queries with durable successful and failed assistants.

### R4 — Medium — Abort intent can be overwritten

- Location: `extensions/process-subagents/runtime.ts:836-845`
- Multiple cancellation paths unconditionally replace `abortIntent`, so a later shutdown/tree cancellation can change an earlier explicit abort into `interrupted`.
- Record the first abort intent only and preserve it through serialized terminal commitment.
- Test explicit stop, tool cancellation, shutdown, reload, and tree-navigation races in both orders.

### R5 — Medium — Shutdown does not await terminal cleanup

- Location: `extensions/process-subagents/runtime.ts:299-300`, `726-739`, `956-964`
- `activeRuns()` includes `cleanupPending`, but `abortRun()` returns immediately for terminal snapshots. Shutdown can finish while `owner.stop()` and terminal waiter resolution remain pending.
- Await a dedicated cleanup promise for terminal runs whose process shutdown is still in progress.
- Block `owner.stop()` and verify shutdown remains pending until process-tree cleanup completes or fails.

### R6 — Medium — Historical cards cannot reliably bind parallel calls

- Location: `extensions/process-subagents/runtime.ts:251-262`; `contracts.ts:74-86`
- Reload/branch ingestion reconstructs tool ownership by matching prompt/type/description. Identical parallel calls both select the first tool call, overwriting one mapping.
- Persist the originating `toolCallId` in each snapshot and bind directly; retain argument matching only for legacy snapshots.
- Verify two argument-identical parallel starts preserve distinct `(agentId, runId)` cards after reload.

### R7 — Medium — Cleanup errors arrive after result resolution

- Location: `extensions/process-subagents/runtime.ts:815-845`
- `commitAbort()` resolves terminal waiters before a later cleanup failure is appended to the snapshot.
- Include cleanup failure in the final terminal snapshot before resolving foreground/waiting callers.
- Force `owner.stop()` to fail and verify the first returned result contains the curated cleanup error.

### R8 — Medium — Slash-containing bare model IDs

- Location: `extensions/process-subagents/resolution.ts:17-32`
- Any reference containing `/` is treated solely as `provider/id`. A unique bare model ID containing a slash is rejected when no matching provider route exists.
- Prefer an exact canonical route when present; otherwise perform unique exact matching against the complete model ID.
- Cover unique slash-containing IDs, canonical routes, and ambiguous bare IDs.

### R9 — Low — Preflight-failure cards remain spinning

- Location: `extensions/process-subagents/runtime.ts:397-450`; `tools.ts:54-57`, `123-139`
- Definition/model/auth/tool/cap failures can occur before a run mapping exists. The call renderer falls back to a spinner and ignores the error result.
- Make the fallback renderer use `context.isError`/completion state and show a terminal failure card with curated text.
- Exercise unknown definitions, auth failures, unavailable tools, cap rejection, and invalid resumes.

### R10 — Low — Lifecycle coverage remains incomplete

- Location: `extensions/process-subagents/runtime.test.ts:75-187`; `integration.test.ts:61-96`
- Tests cover admission, branch selection, and one foreground start/resume flow, but not waiter cancellation and notification re-eligibility, passive-note deduplication, idempotent fetch/stop, background acceptance, manifest mismatch, early child exit, or provider retry.
- Add observable process/plugin-boundary tests for the omitted acceptance cases, then rerun `npm test` and `npm run typecheck`.
