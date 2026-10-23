import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { WorkerTurn } from "./worker.ts";

/** Test double for a `pi --mode rpc` child process. */
export class FakeRpcChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly commands: any[] = [];
  readonly signals: NodeJS.Signals[] = [];
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinEnded = false;
  readonly stdin: Writable;
  private buffer = "";

  constructor(private readonly handler: (child: FakeRpcChild, command: any) => void, private readonly onKill?: (child: FakeRpcChild, signal: NodeJS.Signals) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.buffer += chunk.toString();
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const command = JSON.parse(this.buffer.slice(0, newline));
          this.buffer = this.buffer.slice(newline + 1);
          this.commands.push(command);
          setImmediate(() => this.handler(this, command));
        }
        callback();
      },
      final: (callback) => {
        this.stdinEnded = true;
        setImmediate(() => this.handler(this, { type: "<eof>" }));
        callback();
      },
    });
  }

  emitRecord(record: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(record)}\n`));
  }

  emitRaw(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  respond(command: any, data?: unknown, error?: string): void {
    this.emitRecord({ type: "response", id: command.id, command: command.type, success: !error, data, error });
  }

  /** The worker picked up a user message (a prompt or steer). */
  userMessage(text: string): void {
    this.emitRecord({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
  }

  /** One assistant reply, then settlement. */
  finishRun(reply = "ok", overrides: Record<string, unknown> = {}): void {
    this.emitRecord({ type: "message_end", message: assistantMessage(reply, overrides) });
    this.emitRecord({ type: "agent_settled", aborted: false });
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.onKill) this.onKill(this, signal);
    else setImmediate(() => this.close(null, signal));
    return true;
  }
}

export function assistantMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "m",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

/**
 * Default behavior: answer `get_state`, run each prompt to completion with
 * the reply `done: <message>`, and exit 0 on stdin EOF.
 */
export function defaultHandler(child: FakeRpcChild, command: any): void {
  if (command.type === "<eof>") child.close(0);
  else if (command.type === "get_state") child.respond(command, { sessionId: "session-1", isStreaming: false, pendingMessageCount: 0 });
  else if (command.type === "prompt") {
    child.respond(command, { disposition: "started" });
    child.userMessage(command.message);
    child.finishRun(`done: ${command.message}`);
  } else child.respond(command, {});
}

export interface FakeSpawnOptions {
  handler?: (child: FakeRpcChild, command: any) => void;
  onKill?: (child: FakeRpcChild, signal: NodeJS.Signals) => void;
  onSpawn?: (child: FakeRpcChild, command: string, args: readonly string[]) => void;
}

export function fakeRpcSpawn(options: FakeSpawnOptions = {}) {
  const children: FakeRpcChild[] = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeRpcChild(options.handler ?? defaultHandler, options.onKill);
    children.push(child);
    options.onSpawn?.(child, command, args);
    return child as unknown as ChildProcess;
  }) as any;
  return { spawn, children };
}

/** Collect a worker's turns; `count(n)` resolves once `n` have ended. */
export function turnCollector() {
  const turns: WorkerTurn[] = [];
  const waiters: Array<() => void> = [];
  return {
    turns,
    onTurnEnd: (turn: WorkerTurn) => {
      turns.push(turn);
      waiters.splice(0).forEach((resolve) => resolve());
    },
    count: (n: number) => new Promise<void>((resolve) => {
      const check = () => (turns.length >= n ? resolve() : waiters.push(check));
      check();
    }),
  };
}
