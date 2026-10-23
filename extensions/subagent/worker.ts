import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { prepareLaunch, type Launch, type LaunchHooks } from "./launch.ts";
import {
  MAX_CAPTURED_TRANSCRIPT_BYTES,
  abortedResult,
  capMessage,
  captureToolCalls,
  newResult,
  type AgentResult,
  type ResultIdentity,
  type RunRequest,
} from "./process.ts";
import { RpcTransport, type RpcExit, type RpcResponse } from "./rpc.ts";
import { textOf, utf8Tail } from "./text.ts";
import { trackMessageUsage } from "./usage.ts";

const MAX_TURN_STDERR_BYTES = 64 * 1024;
const SEND_RECEIPT_WAIT_MS = 5_000;

export type WorkerPhase = "starting" | "idle" | "running" | "stopping" | "exited";
export type TurnStatus = "completed" | "failed" | "interrupted";
export type SendOutcome = "started" | "steered" | "queued" | "handled" | "failed";

export interface SendReceipt {
  directiveId: string;
  outcome: SendOutcome;
  turnId?: string;
  reason?: string;
}

export interface WorkerTurn {
  turnId: string;
  status: TurnStatus;
  /** This turn's messages, usage, and stderr, shaped like a synchronous subagent result. */
  result: AgentResult;
}

export interface WorkerOptions {
  launch: Launch;
  /** Identity copied into every turn result. */
  identity: ResultIdentity;
  /** Wait for an active-turn slot before starting a turn from idle. */
  acquireTurn?: () => Promise<{ release(): void }>;
  /** Turns already completed by earlier processes of this conversation; numbering continues after them. */
  previousTurns?: number;
  onTurnEnd?: (turn: WorkerTurn) => void;
  onUpdate?: (result: AgentResult) => void;
  onExit?: (exit: RpcExit) => void;
}

interface Directive {
  id: string;
  text: string;
  settle(receipt: Omit<SendReceipt, "directiveId">): void;
}

interface Turn {
  id: string;
  result: AgentResult;
  capturedBytes: number;
}

/**
 * One persistent `pi --mode rpc` worker. Directives go out as `prompt` with
 * `streamingBehavior: "steer"`, which steers a running worker at its next step
 * and starts a turn when it is idle. One command is in flight at a time. Pi
 * checks its queue only before settling, so a steer accepted during that last
 * check is stranded; the post-settle sweep gets it back with `clear_queue` and
 * starts the next turn with it.
 */
export class RpcWorker {
  phase: WorkerPhase = "starting";
  readonly transport: RpcTransport;
  sessionId?: string;
  sessionFile?: string;
  private turn?: Turn;
  private turnCount: number;
  private readonly hostQueue: Directive[] = [];
  private readonly childQueued = new Map<string, Directive>();
  private inflight?: Directive[];
  private settlePending = false;
  private sweeping = false;
  private lease?: { release(): void };
  private acquiring = false;

  constructor(private readonly options: WorkerOptions) {
    this.turnCount = options.previousTurns ?? 0;
    this.transport = new RpcTransport(options.launch, {
      onEvent: (record) => this.onEvent(record),
      onStderr: (chunk) => {
        if (this.turn) this.turn.result.stderr = utf8Tail(this.turn.result.stderr + chunk, MAX_TURN_STDERR_BYTES);
      },
      onExit: (exit) => this.onExit(exit),
    });
  }

  get currentTurnId(): string | undefined {
    return this.turn?.id;
  }

  get queuedDirectives(): number {
    return this.hostQueue.length + this.childQueued.size + (this.inflight?.length ?? 0);
  }

  async start(): Promise<void> {
    try {
      const state = await this.transport.start();
      this.sessionId = state?.sessionId;
      this.sessionFile = state?.sessionFile;
      if (this.phase === "starting") this.phase = "idle";
    } finally {
      await this.options.launch.cleanup();
    }
    this.pump();
  }

  /**
   * Queue a message for the worker. `raw` sends the text as-is (synchronous
   * tasks); otherwise it is wrapped in a `<director-message>` envelope whose id
   * identifies it in Pi's queue and transcript.
   */
  send(text: string, options: { raw?: boolean } = {}): Promise<SendReceipt> {
    const id = `dir_${randomUUID()}`;
    const body = options.raw ? text : `<director-message id="${id}">\n${text}\n</director-message>`;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (receipt: Omit<SendReceipt, "directiveId">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ directiveId: id, ...receipt });
      };
      const timer = setTimeout(() => settle({ outcome: "queued", reason: "waiting for the worker to accept it" }), SEND_RECEIPT_WAIT_MS);
      timer.unref?.();
      if (this.phase === "stopping" || this.phase === "exited") {
        settle({ outcome: "failed", reason: "worker is not running" });
        return;
      }
      this.hostQueue.push({ id, text: body, settle });
      this.pump();
    });
  }

  /** Graceful shutdown: close stdin, then escalate. */
  stop(): Promise<RpcExit> {
    if (this.phase !== "exited") this.phase = "stopping";
    return this.transport.stop();
  }

  /** Immediate SIGTERM, then SIGKILL. */
  terminate(): Promise<RpcExit> {
    if (this.phase !== "exited") this.phase = "stopping";
    return this.transport.terminate();
  }

  private get gone(): boolean {
    return this.phase === "stopping" || this.phase === "exited";
  }

  private pump(): void {
    if (this.inflight || this.settlePending || this.acquiring || !this.hostQueue.length) return;
    if (this.phase !== "idle" && this.phase !== "running") return;
    if (this.phase === "idle" && this.options.acquireTurn && !this.lease) {
      this.acquiring = true;
      void this.options.acquireTurn().then((lease) => {
        this.acquiring = false;
        if (this.gone) return lease.release();
        this.lease = lease;
        this.pump();
        this.releaseIfIdle();
      });
      return;
    }
    // From idle everything waiting starts one turn; a running turn is steered one directive at a time.
    const batch = this.phase === "idle" ? this.hostQueue.splice(0) : this.hostQueue.splice(0, 1);
    this.inflight = batch;
    const message = batch.map((directive) => directive.text).join("\n\n");
    this.transport
      .request({ type: "prompt", message, streamingBehavior: "steer" }, (response) => this.onPromptResponse(batch, response))
      .catch(() => this.onPromptError(batch));
  }

  private onPromptResponse(batch: Directive[], response: RpcResponse): void {
    if (this.gone) return;
    this.inflight = undefined;
    const disposition = response.success ? response.data?.disposition : undefined;
    if (disposition === "started") {
      // A prompt deferred past settlement starts a new run: finish the old turn
      // first. The new run drains Pi's queue itself, so no sweep is needed.
      if (this.turn) this.closeTurn();
      this.settlePending = false;
      this.openTurn();
      for (const directive of batch) directive.settle({ outcome: "started", turnId: this.turn!.id });
    } else if (disposition === "queued") {
      for (const directive of batch) {
        this.childQueued.set(directive.id, directive);
        directive.settle({ outcome: "steered", turnId: this.turn?.id });
      }
    } else {
      const outcome = disposition === "handled" ? "handled" : "failed";
      for (const directive of batch) directive.settle({ outcome, reason: response.error });
    }
    this.afterCommand();
  }

  /** No response in time: the worker may still act on it, so never resend. */
  private onPromptError(batch: Directive[]): void {
    if (this.gone) return;
    this.inflight = undefined;
    for (const directive of batch) {
      this.childQueued.set(directive.id, directive);
      directive.settle({ outcome: "queued", reason: "the worker did not confirm in time" });
    }
    this.afterCommand();
  }

  private afterCommand(): void {
    if (this.settlePending) void this.sweep();
    else {
      this.pump();
      this.releaseIfIdle();
    }
  }

  /** Hand back the active-turn slot once nothing is running or waiting to run. */
  private releaseIfIdle(): void {
    if (this.turn || this.inflight || this.hostQueue.length || this.settlePending || this.acquiring) return;
    this.lease?.release();
    this.lease = undefined;
  }

  private openTurn(): void {
    this.turnCount++;
    this.turn = { id: `t${this.turnCount}`, result: newResult(this.options.identity), capturedBytes: 0 };
    this.phase = "running";
  }

  private closeTurn(interrupted = false): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    const status: TurnStatus = interrupted ? "interrupted" : turn.result.stopReason === "error" ? "failed" : "completed";
    turn.result.status = interrupted ? "failed" : "done";
    turn.result.exitCode = interrupted ? 1 : 0;
    if (this.phase === "running") this.phase = "idle";
    this.options.onTurnEnd?.({ turnId: turn.id, status, result: turn.result });
  }

  /** After settlement: recover our steers the run left queued, then close the turn. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Only when one of our directives is unaccounted for: clear_queue also
      // drops anything the worker's own extensions queued.
      if (this.childQueued.size) {
        const cleared = await this.transport.request({ type: "clear_queue" }).catch(() => undefined);
        if (this.gone) return;
        const texts: string[] = [...(cleared?.data?.steering ?? []), ...(cleared?.data?.followUp ?? [])];
        const stranded = [...this.childQueued.values()].filter((directive) => texts.some((text) => text.includes(directive.id)));
        this.childQueued.clear();
        this.hostQueue.unshift(...stranded);
      }
      this.closeTurn();
    } finally {
      this.sweeping = false;
      this.settlePending = false;
      this.pump();
      this.releaseIfIdle();
    }
  }

  private onEvent(record: any): void {
    if (this.gone) return;
    if (record?.type === "message_start" && record.message?.role === "user") {
      const text = textOf(record.message.content);
      for (const id of this.childQueued.keys()) if (text.includes(id)) this.childQueued.delete(id);
    } else if (record?.type === "message_end") {
      const message = record.message as Message | undefined;
      if (message?.role !== "assistant" && message?.role !== "toolResult") return;
      // A run the worker started on its own opens a turn lazily.
      if (!this.turn) this.openTurn();
      this.capture(this.turn!, message);
    } else if (record?.type === "agent_settled") {
      this.settlePending = true;
      if (!this.inflight) void this.sweep();
    }
  }

  private capture(turn: Turn, message: Message): void {
    const result = turn.result;
    captureToolCalls(result, message);
    const captured = capMessage(message);
    const bytes = Buffer.byteLength(JSON.stringify(captured), "utf8");
    while (result.messages.length && turn.capturedBytes + bytes > MAX_CAPTURED_TRANSCRIPT_BYTES) {
      turn.capturedBytes -= Buffer.byteLength(JSON.stringify(result.messages.shift()), "utf8");
    }
    result.messages.push(captured);
    turn.capturedBytes += bytes;
    trackMessageUsage(result.usage, message);
    if (message.role === "assistant") {
      result.model = `${message.provider}/${message.responseModel ?? message.model}`;
      result.stopReason = message.stopReason;
      result.errorMessage = message.errorMessage;
      this.options.onUpdate?.(result);
    }
  }

  private onExit(exit: RpcExit): void {
    this.phase = "exited";
    this.closeTurn(true);
    for (const directive of [...this.hostQueue.splice(0), ...(this.inflight ?? [])]) {
      directive.settle({ outcome: "failed", reason: "worker exited" });
    }
    this.inflight = undefined;
    this.childQueued.clear();
    this.lease?.release();
    this.lease = undefined;
    this.options.onExit?.(exit);
  }
}

/** Run one task in a disposable `pi --mode rpc --no-session` child and wait for its turn to end. */
export async function runPiSubagent(request: RunRequest, hooks: LaunchHooks = {}): Promise<AgentResult> {
  if (request.signal?.aborted) return abortedResult(request);
  const launch = await prepareLaunch({
    agent: request.agent,
    cwd: request.cwd,
    model: request.model,
    thinking: request.thinking,
    environment: request.environment,
    session: { kind: "none" },
  }, hooks);
  try {
    if (request.signal?.aborted) return abortedResult(request);
    let aborted = false;
    let turn: WorkerTurn | undefined;
    const worker = new RpcWorker({
      launch,
      identity: request,
      onTurnEnd: (ended) => {
        turn ??= ended;
        void worker.stop();
      },
      onUpdate: request.onUpdate,
    });
    const onAbort = () => {
      aborted = true;
      void worker.terminate();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await worker.start().then(
        () => worker.send(`Task: ${request.task}`, { raw: true }),
        () => worker.terminate(),
      );
      const exit = await worker.transport.waitForExit();
      const result = turn?.result ?? newResult(request);
      if (aborted) Object.assign(result, { status: "aborted", exitCode: 130, stopReason: "aborted" });
      else if (exit.spawnError) Object.assign(result, { status: "spawn-error", exitCode: 1 });
      else if (turn && turn.status !== "interrupted") Object.assign(result, { status: "done", exitCode: 0 });
      else Object.assign(result, { status: "failed", exitCode: exit.exitCode || 1 });

      const { stderr, startedAt, ...diagnostics } = worker.transport.diagnostics;
      result.stderr = stderr;
      if (result.status !== "done") {
        const { spawnError, ...termination } = exit;
        result.process = {
          ...diagnostics,
          durationMs: Date.now() - startedAt,
          termination: Object.keys(termination).length ? termination : undefined,
          spawnError,
        };
      }
      return result;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await launch.cleanup();
  }
}
