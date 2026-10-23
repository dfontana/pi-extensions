import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { utf8Tail } from "./text.ts";

// Pi's agent_end and turn_end records carry whole transcripts and can be
// huge; nothing here needs them, so lines past this size are skipped.
const MAX_RECORD_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_TAIL_BYTES = 16 * 1024;
const READY_TIMEOUT_MS = 10_000;

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface RpcExit {
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  escalatedToSigkill?: boolean;
  spawnError?: string;
}

export interface RpcDiagnostics {
  pid?: number;
  startedAt: number;
  stderr: string;
  /** Recent stdout lines that were not valid JSON. */
  stdoutTail: string;
  protocolErrors: number;
}

/** Test seams for the child process and its stop timing. */
export interface ProcessHooks {
  spawn?: typeof nodeSpawn;
  requestTimeoutMs?: number;
  /** Delay between closing stdin and SIGTERM on a graceful stop. */
  shutdownGraceMs?: number;
  /** Delay between SIGTERM and SIGKILL. */
  escalationDelayMs?: number;
}

export interface RpcTransportOptions extends ProcessHooks {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RpcHandlers {
  onEvent(record: any): void;
  onStderr?(chunk: string): void;
  onExit(exit: RpcExit): void;
}

interface Pending {
  onResponse?: (response: RpcResponse) => void;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function after(ms: number, fn: () => void): NodeJS.Timeout {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

/**
 * One `pi --mode rpc` child: LF-delimited JSON records on stdio and
 * id-correlated commands. Workers have no interactive user, so every
 * extension dialog is answered as cancelled.
 */
export class RpcTransport {
  readonly diagnostics: RpcDiagnostics = { startedAt: Date.now(), stderr: "", stdoutTail: "", protocolErrors: 0 };
  private child?: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private line = "";
  private skipping = false;
  private exit?: RpcExit;
  private exited?: Promise<RpcExit>;
  private escalated = false;
  private terminating = false;

  constructor(private readonly options: RpcTransportOptions, private readonly handlers: RpcHandlers) {}

  get alive(): boolean {
    return this.child !== undefined && this.exit === undefined;
  }

  /** Spawn the child and wait until it answers `get_state`. */
  async start(): Promise<any> {
    const child = (this.options.spawn ?? nodeSpawn)(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.diagnostics.pid = child.pid;
    this.diagnostics.startedAt = Date.now();
    this.exited = new Promise((resolve) => {
      let spawnError: string | undefined;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exit) return;
        if (this.line && !this.skipping) this.handleLine(this.line);
        const exit: RpcExit = {};
        if (code !== null) exit.exitCode = code;
        if (signal) exit.signal = signal;
        if (this.escalated) exit.escalatedToSigkill = true;
        if (spawnError) exit.spawnError = spawnError;
        this.exit = exit;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(spawnError ? `Pi failed to spawn: ${spawnError}` : "Pi RPC child exited"));
        }
        this.pending.clear();
        this.handlers.onExit(exit);
        resolve(exit);
      };
      child.on("error", (error) => {
        spawnError = error.message;
        finish(null, null);
      });
      child.on("close", finish);
    });
    const decoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => this.consume(decoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const stderr = this.diagnostics.stderr + text;
      this.diagnostics.stderr = Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES
        ? `[earlier stderr truncated]\n${utf8Tail(stderr, MAX_STDERR_BYTES)}`
        : stderr;
      this.handlers.onStderr?.(text);
    });
    child.stdin?.on("error", () => {});

    const response = await this.request({ type: "get_state" }, undefined, READY_TIMEOUT_MS);
    if (!response.success) throw new Error(response.error ?? "Pi RPC get_state failed");
    return response.data;
  }

  /**
   * Send a command and resolve with its response. `onResponse` sees the
   * response synchronously, before any record that follows it in the stream.
   * A timeout means the outcome is unknown, not that the command failed.
   */
  request(
    command: Record<string, unknown> & { type: string },
    onResponse?: (response: RpcResponse) => void,
    timeoutMs = this.options.requestTimeoutMs ?? 5_000,
  ): Promise<RpcResponse> {
    if (!this.alive) return Promise.reject(new Error("Pi RPC child is not running"));
    const id = `c${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = after(timeoutMs, () => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command ${command.type} did not respond in time`));
      });
      this.pending.set(id, { onResponse, resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** Resolves once the child has exited (immediately if it never spawned). */
  waitForExit(): Promise<RpcExit> {
    return this.exited ?? Promise.resolve({});
  }

  /** Close stdin, then escalate SIGTERM → SIGKILL if the child lingers. */
  stop(): Promise<RpcExit> {
    if (this.alive) {
      this.child!.stdin?.end();
      const timer = after(this.options.shutdownGraceMs ?? 5_000, () => void this.terminate());
      void this.exited!.then(() => clearTimeout(timer));
    }
    return this.waitForExit();
  }

  /** SIGTERM now, SIGKILL after the escalation delay. */
  terminate(): Promise<RpcExit> {
    if (this.alive && !this.terminating) {
      this.terminating = true;
      const child = this.child!;
      const timer = after(this.options.escalationDelayMs ?? 5_000, () => {
        this.escalated = true;
        child.kill("SIGKILL");
      });
      void this.exited!.then(() => clearTimeout(timer));
      child.kill("SIGTERM");
    }
    return this.waitForExit();
  }

  private write(record: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(record)}\n`);
  }

  private consume(chunk: string): void {
    const parts = (this.line + chunk).split("\n");
    this.line = parts.pop()!;
    for (const part of parts) {
      // The first newline after an oversized line ends it.
      if (this.skipping) this.skipping = false;
      else this.handleLine(part);
    }
    if (this.line.length > MAX_RECORD_CHARS) {
      this.line = "";
      this.skipping = true;
    }
  }

  private handleLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      this.diagnostics.protocolErrors++;
      this.diagnostics.stdoutTail = utf8Tail(`${this.diagnostics.stdoutTail}${line}\n`, MAX_STDOUT_TAIL_BYTES);
      return;
    }
    if (record?.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      pending.onResponse?.(record);
      pending.resolve(record);
      return;
    }
    // Pi resolves select/input/editor to undefined and confirm to false on
    // cancellation, and ignores replies to fire-and-forget requests.
    if (record?.type === "extension_ui_request") {
      this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
      return;
    }
    this.handlers.onEvent(record);
  }
}
