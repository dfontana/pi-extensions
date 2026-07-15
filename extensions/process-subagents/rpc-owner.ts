import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

const STDERR_LIMIT = 16 * 1024;

type RpcWireEvent = Record<string, unknown> & { type: string };
type EventListener = (event: RpcWireEvent) => void;
type ActivityListener = (preview?: string) => void;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface RpcOwnerOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export class RpcOwner {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pid: number | undefined;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly exitDeferred = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  private readonly pending = new Map<string, ReturnType<typeof deferred<RpcResponse>>>();
  private readonly listeners = new Set<EventListener>();
  private readonly activityListeners = new Set<ActivityListener>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private framingError?: Error;
  private stderrBuffer = "";
  private stopPromise?: Promise<void>;

  constructor(options: RpcOwnerOptions) {
    const invocation = getPiInvocation(options.args);
    const spawnProcess = options.spawnProcess ?? spawn;
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    };
    this.process = spawnProcess(invocation.command, invocation.args, spawnOptions) as ChildProcessWithoutNullStreams;
    this.pid = this.process.pid;
    this.exit = this.exitDeferred.promise;
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      // Keep a bounded diagnostic tail in-process only. It is never shown, persisted, or returned.
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT);
    });
    this.process.once("error", (error) => {
      this.failAll(new Error(`Failed to spawn child Pi: ${error.message}`));
    });
    this.process.once("close", (code, signal) => {
      const tail = this.decoder.end();
      if (tail) this.buffer += tail;
      if (this.buffer.length > 0 && !this.framingError) {
        this.framingError = new Error("Malformed child RPC stream: final JSON record was not LF-terminated");
      }
      this.closed = true;
      const error = this.framingError ?? new Error("Child Pi exited before replying");
      this.failAll(error);
      this.exitDeferred.resolve({ code, signal });
    });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private emitActivity(preview?: string): void {
    for (const listener of this.activityListeners) listener(preview);
  }

  private consume(chunk: Buffer): void {
    if (this.framingError) return;
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) return this.protocolFailure("Malformed child RPC stream: blank line");
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { return this.protocolFailure("Malformed child RPC stream: invalid JSON"); }
      if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
        return this.protocolFailure("Malformed child RPC stream: record is not an RPC object");
      }
      this.handle(value as RpcWireEvent);
    }
  }

  private protocolFailure(message: string): void {
    this.framingError = new Error(message);
    this.failAll(this.framingError);
    void this.forceKill();
  }

  private handle(event: RpcWireEvent): void {
    this.emitActivity(event.type);
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      const response = event as RpcResponse;
      if (!response.success) pending.reject(new Error(response.error));
      else pending.resolve(response);
      return;
    }
    if (event.type === "extension_ui_request") {
      this.handleUi(event as RpcExtensionUIRequest);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  private handleUi(request: RpcExtensionUIRequest): void {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      this.write({ type: "extension_ui_response", id: request.id, cancelled: true } satisfies RpcExtensionUIResponse);
    }
  }

  private write(value: object): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("Child Pi RPC channel is closed");
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async request<T extends RpcResponse = RpcResponse>(command: RpcCommand): Promise<T> {
    if (this.closed) throw new Error("Child Pi is not running");
    const id = `parent-${this.nextId++}`;
    const pending = deferred<RpcResponse>();
    this.pending.set(id, pending);
    try { this.write({ ...command, id }); }
    catch (error) { this.pending.delete(id); throw error; }
    return pending.promise as Promise<T>;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    await this.request({ type: "abort" });
  }

  stop(graceMs = 1500): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.performStop(graceMs);
    return this.stopPromise;
  }

  private async performStop(graceMs: number): Promise<void> {
    if (this.closed) return;
    try { await Promise.race([this.abort(), new Promise((resolve) => setTimeout(resolve, Math.min(graceMs, 500)))]); }
    catch { /* continue to termination */ }
    if (this.closed) return;
    this.process.stdin.end();
    if (await this.waitForExit(graceMs)) return;
    await this.forceKill("SIGTERM");
    if (await this.waitForExit(750)) return;
    await this.forceKill("SIGKILL");
    if (!(await this.waitForExit(1000))) throw new Error(`Failed to terminate child process tree ${this.pid ?? "(unknown PID)"}`);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return Promise.race([
      this.exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private async forceKill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (!this.pid || this.closed) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill", ["/pid", String(this.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
        killer.once("close", (code) => code === 0 || this.closed ? resolve() : reject(new Error(`taskkill failed with exit code ${code}`)));
        killer.once("error", reject);
      });
      return;
    }
    try { process.kill(-this.pid, signal); }
    catch (groupError) {
      try {
        if (!this.process.kill(signal) && !this.closed) throw groupError;
      } catch (directError) {
        if (!this.closed) throw new Error(`Failed to signal child process tree: ${directError instanceof Error ? directError.message : String(directError)}`);
      }
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
