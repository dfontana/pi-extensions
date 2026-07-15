import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  RpcResponse,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_MANIFEST_COMMAND,
  CHILD_MANIFEST_TYPE,
  CHILD_MARKER,
  boundedPreview,
  isTerminalStatus,
  publicError,
  usageFromStats,
  type AgentDefinition,
  type AgentInput,
  type BackgroundAcceptance,
  type ChildManifest,
  type PersistedRunSnapshot,
  type ResumeSubagentInput,
  type SubagentConfig,
  type TerminalResult,
  type ThinkingLevel,
} from "./contracts.ts";
import { loadAgentDefinitions, loadSubagentConfig } from "./loaders.ts";
import {
  appendSnapshotIfVisible,
  branchContains,
  createChildSession,
  findDurableUserPrompt,
  inspectSnapshotChildSession,
  loadVisibleSnapshots,
  locateToolOrigin,
  taskEnvelope,
  terminalSnapshotFromInspection,
  toTerminalResult,
} from "./persistence.ts";
import { resolveRoute, resolveTools } from "./resolution.ts";
import { RpcOwner, withTimeout } from "./rpc-owner.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

export interface LiveToolState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean };
  partial: boolean;
}

interface RunHandle {
  snapshot: PersistedRunSnapshot;
  owner?: RpcOwner;
  terminal: Deferred<PersistedRunSnapshot>;
  transition: Promise<void>;
  abortIntent?: { status: "aborted" | "interrupted"; reason: string };
  activeWaiters: number;
  preview?: string;
  liveMessage?: unknown;
  liveTools: Map<string, LiveToolState>;
  durableRevision: number;
  cleanupPending: boolean;
  dirty: boolean;
}

export interface RuntimeView {
  snapshot: PersistedRunSnapshot;
  preview?: string;
  liveMessage?: unknown;
  liveTools: LiveToolState[];
  durableRevision: number;
}

function key(snapshot: Pick<PersistedRunSnapshot, "agentId" | "runId">): string {
  return `${snapshot.agentId}:${snapshot.runId}`;
}

function textFromRpcMessage(event: Record<string, unknown>): string | undefined {
  const message = event.message as { role?: string; content?: unknown } | undefined;
  if (message?.role !== "assistant") return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""));
  return texts.join("").trim() || undefined;
}

function resultText(result: TerminalResult): string {
  return JSON.stringify(result, null, 2);
}

function acceptanceText(result: BackgroundAcceptance): string {
  return JSON.stringify(result, null, 2);
}

export class SubagentRuntime {
  private config?: SubagentConfig;
  private definitions?: Map<string, AgentDefinition>;
  private loadKey?: string;
  private loadError?: Error;
  private context?: ExtensionContext;
  private readonly runs = new Map<string, RunHandle>();
  private readonly toolRuns = new Map<string, RunHandle>();
  private readonly listeners = new Set<() => void>();
  private readonly admissionControllers = new Map<AbortController, Promise<void>>();
  private readonly agentAdmissions = new Set<string>();
  private admissions = 0;
  private disposed = false;

  constructor(private readonly pi: ExtensionAPI) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private ensurePersistent(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Subagents require a persisted parent session; --no-session is unsupported");
    return file;
  }

  private ensureLoaded(ctx: ExtensionContext): { config: SubagentConfig; definitions: Map<string, AgentDefinition> } {
    const loadKey = `${ctx.cwd}\0${ctx.isProjectTrusted()}`;
    if (this.loadKey !== loadKey) {
      this.loadKey = loadKey;
      this.loadError = undefined;
      try {
        this.config = loadSubagentConfig(ctx.cwd, ctx.isProjectTrusted());
        this.definitions = loadAgentDefinitions(ctx.cwd, ctx.isProjectTrusted());
      } catch (error) {
        this.loadError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.loadError) throw this.loadError;
    return { config: this.config!, definitions: this.definitions! };
  }

  getConfig(): SubagentConfig | undefined {
    return this.config;
  }

  views(ctx = this.context): RuntimeView[] {
    if (!ctx) return [];
    return [...this.runs.values()]
      .filter((run) => branchContains(ctx.sessionManager, run.snapshot.runOriginEntryId))
      .sort((a, b) => a.snapshot.startedAt.localeCompare(b.snapshot.startedAt))
      .map((run) => this.toView(run));
  }

  private toView(run: RunHandle): RuntimeView {
    return { snapshot: run.snapshot, preview: run.preview, liveMessage: run.liveMessage, liveTools: [...run.liveTools.values()], durableRevision: run.durableRevision };
  }

  private latestVisible(agentId: string, ctx = this.context): RunHandle | undefined {
    if (!ctx) return undefined;
    return [...this.runs.values()]
      .filter((run) => run.snapshot.agentId === agentId && branchContains(ctx.sessionManager, run.snapshot.runOriginEntryId))
      .sort((a, b) => b.snapshot.runNumber - a.snapshot.runNumber)[0];
  }

  runningViews(ctx = this.context): RuntimeView[] {
    return this.views(ctx).filter(({ snapshot }) => snapshot.status === "starting" || snapshot.status === "running");
  }

  getRun(agentId: string): RuntimeView | undefined {
    const run = this.latestVisible(agentId);
    return run ? this.toView(run) : undefined;
  }

  getRunForToolCall(toolCallId: string): RuntimeView | undefined {
    const run = this.toolRuns.get(toolCallId);
    return run ? this.toView(run) : undefined;
  }

  getRunByIds(agentId: string, runId: string): RuntimeView | undefined {
    const run = this.runs.get(`${agentId}:${runId}`);
    return run ? this.toView(run) : undefined;
  }

  async sessionStart(ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    this.disposed = false;
    this.runs.clear();
    this.toolRuns.clear();
    this.admissions = 0;
    try { this.ensureLoaded(ctx); }
    catch (error) { this.loadError = error instanceof Error ? error : new Error(String(error)); }
    const snapshots = loadVisibleSnapshots(ctx.sessionManager);
    for (const snapshot of snapshots.values()) {
      const run: RunHandle = {
        snapshot,
        terminal: deferred<PersistedRunSnapshot>(),
        transition: Promise.resolve(),
        activeWaiters: 0,
        liveTools: new Map(),
        durableRevision: 0,
        cleanupPending: false,
        dirty: false,
      };
      this.runs.set(key(snapshot), run);
      this.bindToolRun(ctx, run);
      if (isTerminalStatus(snapshot.status)) run.terminal.resolve(snapshot);
    }
    for (const run of this.runs.values()) {
      if (run.snapshot.status !== "starting" && run.snapshot.status !== "running") continue;
      let reconciled: PersistedRunSnapshot;
      try {
        if (!run.snapshot.acceptedPromptEntryId && run.snapshot.childSessionFile) {
          const acceptedPromptEntryId = findDurableUserPrompt(
            run.snapshot.childSessionFile,
            taskEnvelope(run.snapshot.prompt),
            run.snapshot.childEntryCursor,
          );
          if (acceptedPromptEntryId) run.snapshot = { ...run.snapshot, acceptedPromptEntryId };
        }
        const inspection = inspectSnapshotChildSession(run.snapshot);
        reconciled = terminalSnapshotFromInspection(run.snapshot, inspection);
      } catch (error) {
        reconciled = {
          ...run.snapshot,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: publicError(error),
          notificationPending: run.snapshot.background && !run.snapshot.resultConsumed,
        };
      }
      this.replaceSnapshot(run, reconciled);
      run.terminal.resolve(reconciled);
    }
    this.reconcileDirty(ctx);
    this.notify();
  }

  private bindToolRun(ctx: ExtensionContext, run: RunHandle): void {
    const entry = ctx.sessionManager.getEntry(run.snapshot.runOriginEntryId);
    if (entry?.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return;
    const expectedName = run.snapshot.runNumber === 1 ? "Agent" : "resume_subagent";
    const call = entry.message.content.find((part) => {
      if (part.type !== "toolCall" || part.name !== expectedName) return false;
      const args = part.arguments as Record<string, unknown>;
      return args.prompt === run.snapshot.prompt && (expectedName === "resume_subagent"
        ? args.agent_id === run.snapshot.agentId
        : args.description === run.snapshot.description && args.subagent_type === run.snapshot.type);
    });
    if (call?.type === "toolCall") this.toolRuns.set(call.id, run);
  }

  private ingestVisibleSnapshots(ctx: ExtensionContext): void {
    for (const snapshot of loadVisibleSnapshots(ctx.sessionManager).values()) {
      if (this.runs.has(key(snapshot))) continue;
      const run: RunHandle = {
        snapshot,
        terminal: deferred<PersistedRunSnapshot>(),
        transition: Promise.resolve(),
        activeWaiters: 0,
        liveTools: new Map(),
        durableRevision: 0,
        cleanupPending: false,
        dirty: false,
      };
      this.runs.set(key(snapshot), run);
      this.bindToolRun(ctx, run);
      if (isTerminalStatus(snapshot.status)) run.terminal.resolve(snapshot);
      else {
        let reconciled: PersistedRunSnapshot;
        try {
          if (!run.snapshot.acceptedPromptEntryId && run.snapshot.childSessionFile) {
            const acceptedPromptEntryId = findDurableUserPrompt(run.snapshot.childSessionFile, taskEnvelope(run.snapshot.prompt), run.snapshot.childEntryCursor);
            if (acceptedPromptEntryId) run.snapshot = { ...run.snapshot, acceptedPromptEntryId };
          }
          reconciled = terminalSnapshotFromInspection(run.snapshot, inspectSnapshotChildSession(run.snapshot));
        } catch (error) {
          reconciled = { ...run.snapshot, status: "failed", completedAt: new Date().toISOString(), error: publicError(error),
            notificationPending: run.snapshot.background && !run.snapshot.resultConsumed };
        }
        this.replaceSnapshot(run, reconciled);
        run.terminal.resolve(reconciled);
      }
    }
  }

  private activeRuns(): RunHandle[] {
    return [...this.runs.values()].filter((run) => run.cleanupPending || run.snapshot.status === "starting" || run.snapshot.status === "running");
  }

  private reserveCapacity(config: SubagentConfig): void {
    const active = this.activeRuns();
    if (active.length + this.admissions >= config.maxConcurrentAgents) {
      const ids = active.map((run) => run.snapshot.agentId);
      if (this.admissions) ids.push(`${this.admissions} starting`);
      throw new Error(`Subagent concurrency limit (${config.maxConcurrentAgents}) reached; active: ${ids.join(", ")}`);
    }
    this.admissions++;
  }

  private releaseAdmission(): void {
    this.admissions = Math.max(0, this.admissions - 1);
  }

  private beginAdmission(externalSignal: AbortSignal | undefined, agentId?: string): { signal: AbortSignal; finish(): void } {
    if (this.disposed) throw new Error("Subagent runtime is shutting down");
    if (agentId) {
      if (this.agentAdmissions.has(agentId)) throw new Error(`Agent ${agentId} already has a resume starting`);
      this.agentAdmissions.add(agentId);
    }
    const controller = new AbortController();
    const done = deferred<void>();
    this.admissionControllers.set(controller, done.promise);
    const cancel = () => controller.abort(new Error("Subagent startup was cancelled"));
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener("abort", cancel, { once: true });
    let finished = false;
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        externalSignal?.removeEventListener("abort", cancel);
        this.admissionControllers.delete(controller);
        if (agentId) this.agentAdmissions.delete(agentId);
        done.resolve();
      },
    };
  }

  private async awaitAdmission<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Subagent startup was cancelled");
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("Subagent startup was cancelled")), { once: true })),
    ]);
  }

  private assertAdmissionLive(signal: AbortSignal, origin: string, ctx: ExtensionContext): void {
    if (this.disposed || signal.aborted) throw new Error("Subagent startup was cancelled during shutdown");
    if (!branchContains(ctx.sessionManager, origin)) throw new Error("The subagent call left the active branch before startup completed");
  }

  private replaceSnapshot(run: RunHandle, snapshot: PersistedRunSnapshot): void {
    if (run.snapshot.status !== snapshot.status) run.durableRevision++;
    run.snapshot = snapshot;
    const ctx = this.context;
    run.dirty = !ctx || !appendSnapshotIfVisible(this.pi, ctx.sessionManager, snapshot);
    this.notify();
  }

  private queueTransition(run: RunHandle, fn: () => Promise<void> | void): Promise<void> {
    run.transition = run.transition.then(fn, fn);
    return run.transition;
  }

  private registerRun(snapshot: PersistedRunSnapshot): RunHandle {
    const run: RunHandle = {
      snapshot,
      terminal: deferred<PersistedRunSnapshot>(),
      transition: Promise.resolve(),
      activeWaiters: 0,
      liveTools: new Map(),
      durableRevision: 0,
      cleanupPending: false,
      dirty: false,
    };
    this.runs.set(key(snapshot), run);
    this.replaceSnapshot(run, snapshot);
    return run;
  }

  private definitionForResume(previous: PersistedRunSnapshot): AgentDefinition {
    return {
      id: previous.type,
      displayName: previous.displayName,
      description: previous.description,
      systemPrompt: previous.systemPrompt,
      tools: previous.tools,
      source: "builtin",
    };
  }

  async start(toolCallId: string, input: AgentInput, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
    const parentSessionFile = this.ensurePersistent(ctx);
    this.context = ctx;
    const { config, definitions } = this.ensureLoaded(ctx);
    const definition = definitions.get(input.subagent_type);
    if (!definition) throw new Error(`Unknown subagent type ${JSON.stringify(input.subagent_type)}. Available: ${[...definitions.keys()].join(", ")}`);
    const origin = locateToolOrigin(ctx.sessionManager, toolCallId);
    this.reserveCapacity(config);
    let admission: ReturnType<SubagentRuntime["beginAdmission"]>;
    try { admission = this.beginAdmission(signal); }
    catch (error) { this.releaseAdmission(); throw error; }
    try {
      const route = await this.awaitAdmission(
        resolveRoute(ctx, config, definition, input.model, input.thinking, this.pi.getThinkingLevel()),
        admission.signal,
      );
      const tools = resolveTools(this.pi.getActiveTools(), this.pi.getAllTools(), definition);
      this.assertAdmissionLive(admission.signal, origin, ctx);
      const background = input.run_in_background ?? definition.runInBackground ?? config.defaultBackground;
      const agentId = `agent-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      const childSessionId = randomUUID();
      const child = createChildSession(ctx.cwd, ctx.sessionManager.getSessionDir(), childSessionId, parentSessionFile);
      const now = new Date().toISOString();
      const snapshot: PersistedRunSnapshot = {
        version: 1,
        agentId,
        runId,
        runNumber: 1,
        agentOriginEntryId: origin,
        runOriginEntryId: origin,
        parentSessionId: ctx.sessionManager.getSessionId(),
        parentSessionFile,
        childSessionId: child.sessionId,
        childSessionFile: child.sessionFile,
        type: definition.id,
        displayName: definition.displayName,
        description: input.description,
        prompt: input.prompt,
        systemPrompt: definition.systemPrompt,
        cwd: ctx.cwd,
        tools,
        modelRequest: route.modelRequest,
        resolvedModel: { provider: route.model.provider, id: route.model.id },
        thinking: route.thinking,
        background,
        status: "starting",
        startedAt: now,
        lastActivityAt: now,
        resultConsumed: false,
        notificationPending: false,
        notificationSent: false,
      };
      const run = this.registerRun(snapshot);
      this.toolRuns.set(toolCallId, run);
      return this.launch(run, signal, ctx);
    } finally {
      admission.finish();
      this.releaseAdmission();
    }
  }

  async resume(toolCallId: string, input: ResumeSubagentInput, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
    this.ensurePersistent(ctx);
    this.context = ctx;
    const { config } = this.ensureLoaded(ctx);
    const previousRun = this.latestVisible(input.agent_id, ctx);
    if (!previousRun) throw new Error(`Unknown agent ID ${input.agent_id}`);
    if (previousRun.cleanupPending) await previousRun.terminal.promise;
    const previous = previousRun.snapshot;
    if (!isTerminalStatus(previous.status)) throw new Error(`Agent ${input.agent_id} is ${previous.status} and cannot be resumed`);
    if (!previous.childSessionFile || !fs.existsSync(previous.childSessionFile)) {
      throw new Error(`Agent ${input.agent_id} has no valid child session to resume`);
    }
    const priorInspection = inspectSnapshotChildSession(previous);
    const origin = locateToolOrigin(ctx.sessionManager, toolCallId);
    this.reserveCapacity(config);
    let admission: ReturnType<SubagentRuntime["beginAdmission"]>;
    try { admission = this.beginAdmission(signal, input.agent_id); }
    catch (error) { this.releaseAdmission(); throw error; }
    try {
      const definition = this.definitionForResume(previous);
      const route = await this.awaitAdmission(
        resolveRoute(ctx, config, definition, input.model, input.thinking, this.pi.getThinkingLevel(), previous),
        admission.signal,
      );
      const tools = resolveTools(this.pi.getActiveTools(), this.pi.getAllTools(), definition, previous.tools);
      this.assertAdmissionLive(admission.signal, origin, ctx);
      const now = new Date().toISOString();
      const snapshot: PersistedRunSnapshot = {
        ...previous,
        runId: `run-${randomUUID()}`,
        runNumber: previous.runNumber + 1,
        runOriginEntryId: origin,
        prompt: input.prompt,
        tools,
        modelRequest: route.modelRequest,
        resolvedModel: { provider: route.model.provider, id: route.model.id },
        thinking: route.thinking,
        background: input.run_in_background ?? false,
        status: "starting",
        startedAt: now,
        completedAt: undefined,
        lastActivityAt: now,
        childEntryCursor: priorInspection.entries.at(-1)?.id,
        acceptedPromptEntryId: undefined,
        resultConsumed: false,
        notificationPending: false,
        notificationSent: false,
        resultPreview: undefined,
        stopReason: undefined,
        error: undefined,
        usage: undefined,
        cost: undefined,
        contextUsage: undefined,
      };
      const run = this.registerRun(snapshot);
      this.toolRuns.set(toolCallId, run);
      return this.launch(run, signal, ctx);
    } finally {
      admission.finish();
      this.releaseAdmission();
    }
  }

  private launchArgs(snapshot: PersistedRunSnapshot, trusted: boolean): string[] {
    const guardPath = fileURLToPath(new URL("./child-guard.ts", import.meta.url));
    return [
      "--mode", "rpc",
      "--session", snapshot.childSessionFile!,
      "--name", `subagent:${snapshot.type}:${snapshot.description}`,
      "--provider", snapshot.resolvedModel.provider,
      "--model", snapshot.resolvedModel.id,
      "--thinking", snapshot.thinking,
      "--tools", snapshot.tools.join(","),
      "--system-prompt", snapshot.systemPrompt,
      "--extension", guardPath,
      trusted ? "--approve" : "--no-approve",
    ];
  }

  private async launch(run: RunHandle, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
    const snapshot = run.snapshot;
    const owner = new RpcOwner({
      args: this.launchArgs(snapshot, ctx.isProjectTrusted()),
      cwd: snapshot.cwd,
      env: { ...process.env, [CHILD_MARKER]: "1" },
    });
    run.owner = owner;
    owner.onActivity((preview) => {
      run.snapshot.lastActivityAt = new Date().toISOString();
      if (preview) run.preview = boundedPreview(preview, 160);
      this.notify();
    });
    owner.onEvent((event) => {
      const preview = textFromRpcMessage(event);
      if (preview) run.preview = boundedPreview(preview, 160);
      const message = event.message as { role?: string } | undefined;
      if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && message?.role === "assistant") {
        run.liveMessage = event.message;
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const toolCallId = String(event.toolCallId ?? "");
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        const previous = run.liveTools.get(toolCallId);
        const rawResult = event.type === "tool_execution_update" ? event.partialResult : event.type === "tool_execution_end" ? event.result : undefined;
        const resultRecord = rawResult && typeof rawResult === "object" ? rawResult as { content?: unknown; details?: unknown; isError?: unknown } : undefined;
        const liveResult = resultRecord && Array.isArray(resultRecord.content) ? {
          content: resultRecord.content as LiveToolState["result"] extends { content: infer T } ? T : never,
          details: resultRecord.details,
          isError: event.type === "tool_execution_end" ? Boolean(event.isError) : Boolean(resultRecord.isError),
        } : previous?.result;
        run.liveTools.set(toolCallId, {
          toolCallId,
          toolName,
          args: event.args ?? previous?.args ?? {},
          result: liveResult,
          partial: event.type !== "tool_execution_end",
        });
        run.preview = toolName;
      }
      if (event.type === "message_end" || event.type === "tool_execution_end") void this.reconcileLiveOverlay(run, event);
      if (event.type === "agent_settled") void this.settle(run);
      this.notify();
    });
    void owner.exit.then(() => this.processExited(run));

    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => { void this.abortRun(run, "tool-call-cancelled", "aborted"); };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
    try {
      await this.handshakeAndPrompt(run, ctx);
      if (run.abortIntent) await run.terminal.promise;
      if (isTerminalStatus(run.snapshot.status)) {
        const terminal = await this.consume(run);
        return resultText(terminal);
      }
      const running = { ...run.snapshot, status: "running" as const, lastActivityAt: new Date().toISOString() };
      this.replaceSnapshot(run, running);
      if (running.background) {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        return acceptanceText({
          agentId: running.agentId,
          runId: running.runId,
          childSessionId: running.childSessionId,
          childSessionFile: running.childSessionFile!,
          status: "running",
        });
      }
      const terminal = await run.terminal.promise;
      return resultText(await this.consume(run, terminal));
    } catch (error) {
      if (!isTerminalStatus(run.snapshot.status)) {
        await this.failStartup(run, error);
      }
      return resultText(await this.consume(run));
    } finally {
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }

  private async reconcileLiveOverlay(run: RunHandle, event: Record<string, unknown>): Promise<void> {
    try {
      await run.owner?.request({ type: "get_entries" });
      if (event.type === "message_end") run.liveMessage = undefined;
      if (event.type === "tool_execution_end") run.liveTools.delete(String(event.toolCallId ?? ""));
      run.durableRevision++;
      this.notify();
    } catch { /* settlement/exit performs the final durable redraw */ }
  }

  private async handshakeAndPrompt(run: RunHandle, ctx: ExtensionContext): Promise<void> {
    const owner = run.owner!;
    const stateResponse = await withTimeout(owner.request({ type: "get_state" }), 10_000, "Child RPC startup");
    const state = (stateResponse as Extract<RpcResponse, { command: "get_state" }>).data as RpcSessionState;
    const snapshot = run.snapshot;
    if (state.sessionId !== snapshot.childSessionId || state.sessionFile !== snapshot.childSessionFile ||
        state.model?.provider !== snapshot.resolvedModel.provider || state.model?.id !== snapshot.resolvedModel.id ||
        state.thinkingLevel !== snapshot.thinking) {
      throw new Error("Child RPC state did not match the requested session, model, or thinking level");
    }
    await withTimeout(owner.request({ type: "prompt", message: `/${CHILD_MANIFEST_COMMAND}` }), 10_000, "Child manifest command");
    const manifest = await this.fetchManifest(owner, snapshot.childEntryCursor);
    this.validateManifest(manifest, run.snapshot, ctx.isProjectTrusted());
    const envelope = taskEnvelope(run.snapshot.prompt);
    await withTimeout(owner.request({ type: "prompt", message: envelope }), 10_000, "Child prompt acceptance");
    const acceptedPromptEntryId = await this.waitForDurablePrompt(run.snapshot.childSessionFile!, envelope, snapshot.childEntryCursor);
    this.replaceSnapshot(run, { ...run.snapshot, acceptedPromptEntryId });
  }

  private async fetchManifest(owner: RpcOwner, cursor?: string): Promise<ChildManifest> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await owner.request({ type: "get_entries" }) as Extract<RpcResponse, { command: "get_entries" }>;
      const entries = response.data.entries;
      const cursorIndex = cursor ? entries.findIndex((candidate) => candidate.id === cursor) : -1;
      if (cursor && cursorIndex < 0) throw new Error(`Child session cursor ${cursor} is missing`);
      const entry = entries.slice(cursorIndex + 1).reverse().find((candidate) =>
        candidate.type === "custom" && candidate.customType === CHILD_MANIFEST_TYPE);
      if (entry?.type === "custom" && entry.data && typeof entry.data === "object") return entry.data as ChildManifest;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Child manifest handshake was not persisted");
  }

  private validateManifest(manifest: ChildManifest, snapshot: PersistedRunSnapshot, trusted: boolean): void {
    const tools = [...manifest.tools].sort();
    if (manifest.version !== 1 || manifest.sessionId !== snapshot.childSessionId ||
        manifest.sessionFile !== snapshot.childSessionFile || manifest.cwd !== snapshot.cwd ||
        manifest.trusted !== trusted || manifest.model?.provider !== snapshot.resolvedModel.provider ||
        manifest.model?.id !== snapshot.resolvedModel.id || manifest.thinking !== snapshot.thinking ||
        JSON.stringify(tools) !== JSON.stringify(snapshot.tools)) {
      throw new Error("Child manifest did not match cwd, trust, session, model, thinking, or effective tools");
    }
  }

  private async waitForDurablePrompt(filePath: string, envelope: string, cursor?: string): Promise<string> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const entryId = findDurableUserPrompt(filePath, envelope, cursor);
        if (entryId) return entryId;
      } catch { /* writer may be between records; retry within bounded startup */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Child accepted the prompt but did not durably persist the exact new user message");
  }

  private async settle(run: RunHandle): Promise<void> {
    await this.queueTransition(run, async () => {
      if (isTerminalStatus(run.snapshot.status)) return;
      const owner = run.owner;
      try {
        const [textResponse, statsResponse] = await Promise.all([
          owner!.request({ type: "get_last_assistant_text" }) as Promise<Extract<RpcResponse, { command: "get_last_assistant_text" }>>,
          owner!.request({ type: "get_session_stats" }) as Promise<Extract<RpcResponse, { command: "get_session_stats" }>>,
        ]);
        if (run.abortIntent) {
          await owner?.stop();
          run.owner = undefined;
          await this.commitAbort(run);
          return;
        }
        const stats = statsResponse.data as SessionStats;
        const inspection = inspectSnapshotChildSession(run.snapshot);
        const status = inspection.failed ? "failed" : "completed";
        let terminal: PersistedRunSnapshot = {
          ...run.snapshot,
          status,
          completedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          resultPreview: boundedPreview(textResponse.data.text ?? inspection.result),
          stopReason: inspection.stopReason,
          error: inspection.error,
          usage: usageFromStats(stats),
          cost: stats.cost,
          contextUsage: stats.contextUsage,
          notificationPending: run.snapshot.background && !run.snapshot.resultConsumed && run.activeWaiters === 0,
        };
        // This replace is the serialized terminal commit point. Abort intent recorded before it wins.
        if (run.abortIntent) {
          await owner?.stop();
          run.owner = undefined;
          await this.commitAbort(run);
          return;
        }
        run.cleanupPending = true;
        this.replaceSnapshot(run, terminal);
        try {
          await owner?.stop();
        } catch (error) {
          terminal = { ...terminal, status: "failed", error: publicError(error) };
          this.replaceSnapshot(run, terminal);
        }
        run.owner = undefined;
        run.liveMessage = undefined;
        run.liveTools.clear();
        run.cleanupPending = false;
        run.durableRevision++;
        run.terminal.resolve(terminal);
      } catch (error) {
        let cleanupError: unknown;
        try { await owner?.stop(); } catch (failure) { cleanupError = failure; }
        run.owner = undefined;
        if (run.abortIntent) {
          await this.commitAbort(run);
          if (cleanupError) this.replaceSnapshot(run, { ...run.snapshot, error: publicError(cleanupError) });
        } else await this.commitInterrupted(run, cleanupError ?? error);
      }
    });
  }

  private async processExited(run: RunHandle): Promise<void> {
    await this.queueTransition(run, async () => {
      if (isTerminalStatus(run.snapshot.status)) return;
      if (run.abortIntent) return this.commitAbort(run);
      try {
        const inspection = inspectSnapshotChildSession(run.snapshot);
        if (inspection.terminal && inspection.failed) {
          const failed = terminalSnapshotFromInspection(run.snapshot, inspection, "failed");
          this.replaceSnapshot(run, failed);
          run.terminal.resolve(failed);
          return;
        }
      } catch { /* curated interrupted error below */ }
      await this.commitInterrupted(run, new Error("Child process exited before settlement"));
    });
  }

  private async failStartup(run: RunHandle, error: unknown): Promise<void> {
    await this.queueTransition(run, async () => {
      if (isTerminalStatus(run.snapshot.status)) return;
      if (run.abortIntent) return this.commitAbort(run);
      const failed: PersistedRunSnapshot = {
        ...run.snapshot,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: publicError(error),
        notificationPending: false,
      };
      run.cleanupPending = true;
      this.replaceSnapshot(run, failed);
      let terminal = failed;
      try { await run.owner?.stop(); }
      catch (cleanupError) {
        terminal = { ...failed, error: `${failed.error}; ${publicError(cleanupError)}` };
        this.replaceSnapshot(run, terminal);
      }
      run.owner = undefined;
      run.cleanupPending = false;
      run.durableRevision++;
      run.terminal.resolve(terminal);
    });
  }

  private async commitInterrupted(run: RunHandle, error: unknown): Promise<void> {
    if (isTerminalStatus(run.snapshot.status)) return;
    let inspection;
    try { inspection = inspectSnapshotChildSession(run.snapshot); }
    catch { inspection = undefined; }
    const terminal: PersistedRunSnapshot = {
      ...run.snapshot,
      status: "interrupted",
      completedAt: new Date().toISOString(),
      resultPreview: boundedPreview(inspection?.result),
      stopReason: inspection?.stopReason,
      error: publicError(error),
      usage: inspection?.usage,
      cost: inspection?.cost,
      notificationPending: run.snapshot.background && !run.snapshot.resultConsumed && run.activeWaiters === 0,
    };
    this.replaceSnapshot(run, terminal);
    run.terminal.resolve(terminal);
  }

  private async commitAbort(run: RunHandle): Promise<void> {
    if (isTerminalStatus(run.snapshot.status)) return;
    const intent = run.abortIntent ?? { status: "aborted" as const, reason: "stopped" };
    let inspection;
    try { inspection = inspectSnapshotChildSession(run.snapshot); }
    catch { inspection = undefined; }
    const terminal: PersistedRunSnapshot = {
      ...run.snapshot,
      status: intent.status,
      completedAt: new Date().toISOString(),
      resultPreview: boundedPreview(inspection?.result),
      stopReason: intent.reason,
      error: intent.status === "interrupted" ? intent.reason : undefined,
      usage: inspection?.usage,
      cost: inspection?.cost,
      notificationPending: run.snapshot.background && !run.snapshot.resultConsumed && run.activeWaiters === 0,
    };
    this.replaceSnapshot(run, terminal);
    run.terminal.resolve(terminal);
  }

  private async abortRun(run: RunHandle, reason: string, status: "aborted" | "interrupted"): Promise<PersistedRunSnapshot> {
    if (isTerminalStatus(run.snapshot.status)) return run.snapshot;
    run.abortIntent = { reason, status };
    let cleanupError: unknown;
    try { await run.owner?.stop(); } catch (error) { cleanupError = error; }
    await this.queueTransition(run, () => this.commitAbort(run));
    run.owner = undefined;
    if (cleanupError) {
      this.replaceSnapshot(run, { ...run.snapshot, error: publicError(cleanupError) });
    }
    return run.snapshot;
  }

  async getResult(agentId: string, wait: boolean, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
    this.ensurePersistent(ctx);
    this.context = ctx;
    const run = this.latestVisible(agentId, ctx);
    if (!run) throw new Error(`Unknown agent ID ${agentId}`);
    if (run.cleanupPending) await run.terminal.promise;
    if (!wait && !isTerminalStatus(run.snapshot.status)) {
      return JSON.stringify({
        agentId: run.snapshot.agentId,
        runId: run.snapshot.runId,
        status: run.snapshot.status,
        childSessionId: run.snapshot.childSessionId,
        childSessionFile: run.snapshot.childSessionFile,
        lastActivityAt: run.snapshot.lastActivityAt,
        preview: run.preview,
      }, null, 2);
    }
    if (wait && !isTerminalStatus(run.snapshot.status)) {
      run.activeWaiters++;
      try {
        if (signal) {
          if (signal.aborted) throw new Error("Result wait cancelled");
          await Promise.race([
            run.terminal.promise,
            new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Result wait cancelled")), { once: true })),
          ]);
        } else await run.terminal.promise;
      } finally {
        run.activeWaiters--;
        if (isTerminalStatus(run.snapshot.status) && run.snapshot.background && !run.snapshot.resultConsumed &&
            !run.snapshot.notificationPending && !run.snapshot.notificationSent) {
          this.replaceSnapshot(run, { ...run.snapshot, notificationPending: true });
        }
      }
    }
    return resultText(await this.consume(run));
  }

  private async consume(run: RunHandle, terminal = run.snapshot): Promise<TerminalResult> {
    if (!isTerminalStatus(terminal.status)) terminal = await run.terminal.promise;
    let fullResult = terminal.resultPreview;
    if (terminal.childSessionFile) {
      try { fullResult = inspectSnapshotChildSession(terminal).result ?? fullResult; }
      catch (error) {
        if (!terminal.error) terminal = { ...terminal, error: publicError(error) };
      }
    }
    if (!terminal.resultConsumed || terminal.notificationPending) {
      terminal = { ...terminal, resultConsumed: true, notificationPending: false };
      this.replaceSnapshot(run, terminal);
    }
    return toTerminalResult(terminal, fullResult);
  }

  async stop(agentId: string, ctx: ExtensionContext): Promise<string> {
    this.ensurePersistent(ctx);
    this.context = ctx;
    const run = this.latestVisible(agentId, ctx);
    if (!run) throw new Error(`Unknown agent ID ${agentId}`);
    if (run.cleanupPending) await run.terminal.promise;
    if (!isTerminalStatus(run.snapshot.status)) await this.abortRun(run, "explicit-stop", "aborted");
    let fullResult = run.snapshot.resultPreview;
    if (run.snapshot.childSessionFile) {
      try { fullResult = inspectSnapshotChildSession(run.snapshot).result ?? fullResult; } catch { /* retained curated state */ }
    }
    return resultText(toTerminalResult(run.snapshot, fullResult));
  }

  deliverPending(ctx: ExtensionContext): { customType: string; content: string; display: true; details: unknown } | undefined {
    this.context = ctx;
    const pending = [...this.runs.values()].filter((run) => !run.cleanupPending && run.snapshot.notificationPending &&
      !run.snapshot.notificationSent && !run.snapshot.resultConsumed &&
      branchContains(ctx.sessionManager, run.snapshot.runOriginEntryId));
    if (!pending.length) return undefined;
    const lines: string[] = [];
    for (const run of pending) {
      this.replaceSnapshot(run, { ...run.snapshot, notificationPending: false, notificationSent: true });
      lines.push(`${run.snapshot.displayName} (${run.snapshot.agentId}) ${run.snapshot.status}: ${run.snapshot.resultPreview ?? run.snapshot.error ?? "no result text"}`);
    }
    return {
      customType: "process-subagents-completions",
      content: `Background subagents completed:\n\n${lines.join("\n\n")}`,
      display: true,
      details: { runs: pending.map((run) => ({ agentId: run.snapshot.agentId, runId: run.snapshot.runId })) },
    };
  }

  async beforeTree(targetId: string, ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    const target = ctx.sessionManager.getEntry(targetId);
    const destination = target && ((target.type === "message" && target.message.role === "user") || target.type === "custom_message")
      ? target.parentId ?? undefined : targetId;
    const destinationBranch = new Set(ctx.sessionManager.getBranch(destination).map((entry) => entry.id));
    const stops = this.activeRuns().filter((run) => !destinationBranch.has(run.snapshot.runOriginEntryId))
      .map((run) => this.abortRun(run, "tree-navigation", "aborted"));
    await Promise.all(stops);
  }

  reconcileDirty(ctx: ExtensionContext): void {
    this.context = ctx;
    this.ingestVisibleSnapshots(ctx);
    for (const run of this.runs.values()) {
      if (run.dirty && appendSnapshotIfVisible(this.pi, ctx.sessionManager, run.snapshot)) run.dirty = false;
    }
    this.notify();
  }

  async shutdown(reason: string): Promise<void> {
    this.disposed = true;
    const admissionDone = [...this.admissionControllers.entries()].map(([controller, done]) => {
      controller.abort(new Error(`Subagent startup interrupted by ${reason}`));
      return done;
    });
    await Promise.all(admissionDone);
    const runs = this.activeRuns();
    await Promise.all(runs.map((run) => this.abortRun(run, reason, "interrupted")));
    this.listeners.clear();
  }
}
