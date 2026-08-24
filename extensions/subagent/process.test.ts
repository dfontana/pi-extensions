import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  captureToolCalls,
  childExtensionArgs,
  formatToolCall,
  childProcessEnvironment,
  resultOutput,
  runPiSubagent,
  SUBAGENT_CHILD_ENV,
  type AgentResult,
} from "./process.ts";
import { emptyTrackedUsage } from "./usage.ts";

const agent = {
  name: "test",
  description: "Test",
  systemPrompt: "",
  filePath: "/tmp/test.md",
};

describe("subagent process", () => {
  it("merges launch-scoped environment and always marks the child", () => {
    const environment = childProcessEnvironment({ TEST_HANDOFF: "snapshot", [SUBAGENT_CHILD_ENV]: "wrong" });
    assert.equal(environment.TEST_HANDOFF, "snapshot");
    assert.equal(environment[SUBAGENT_CHILD_ENV], "1");
  });

  it("inherits only extension flags and resolves their paths against the parent cwd", () => {
    assert.deepEqual(
      childExtensionArgs(
        ["-ne", "-e", ".", "--extension", "extensions/example.ts", "--model", "luna"],
        "/parent/project",
      ),
      [
        "--no-extensions",
        "--extension",
        "/parent/project",
        "--extension",
        "/parent/project/extensions/example.ts",
      ],
    );
  });

  it("retains only the latest visible tool activity", () => {
    const result: AgentResult = {
      agent: "test",
      task: "inspect",
      cwd: "/tmp",
      exitCode: -1,
      status: "running",
      messages: [],
      stderr: "",
      usage: emptyTrackedUsage(),
    };
    const message = {
      role: "assistant",
      content: Array.from({ length: 205 }, (_, index) => ({
        type: "toolCall",
        id: `call-${index}`,
        name: "read",
        arguments: { path: `/tmp/file-${index}.ts` },
      })),
      api: "test",
      provider: "test",
      model: "test",
      usage: emptyTrackedUsage().usage,
      stopReason: "toolUse",
      timestamp: 1,
    } as any;

    captureToolCalls(result, message);
    assert.equal(result.latestToolCall, `read {\n  "path": "/tmp/file-204.ts"\n}`);
    captureToolCalls(result, {
      ...message,
      content: [{ type: "toolCall", id: "later", name: "grep", arguments: { pattern: "later", path: "/tmp" } }],
    });

    assert.equal(result.latestToolCall, `grep {\n  "pattern": "later",\n  "path": "/tmp"\n}`);
    assert.equal("toolCalls" in result, false);
    assert.equal("omittedToolCalls" in result, false);
  });

  it("includes all tool arguments in the expanded-preview payload", () => {
    const command = `printf '%s' ${"x".repeat(200)}`;
    const preview = formatToolCall("bash", { command, timeout: 30, description: "full detail" });

    assert.match(preview, /^bash \{/);
    assert.ok(preview.includes(command));
    assert.match(preview, /"timeout": 30/);
    assert.match(preview, /"description": "full detail"/);
  });

  it("does not spawn when cancellation happens during prompt creation and cleans the prompt", async () => {
    const controller = new AbortController();
    let promptDirectory: string | undefined;
    let spawnCalls = 0;
    const result = await runPiSubagent({
      agent: { ...agent, systemPrompt: "Instructions" },
      task: "cancel during launch",
      cwd: process.cwd(),
      model: "provider/model:HIGH",
      signal: controller.signal,
    }, {
      afterPromptCreation: async (prompt) => {
        promptDirectory = prompt?.directory;
        controller.abort();
      },
      spawn: (() => {
        spawnCalls++;
        throw new Error("spawn should not be reached");
      }) as any,
    });

    assert.equal(spawnCalls, 0);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.thinking, "high");
    assert.ok(promptDirectory);
    assert.equal(existsSync(promptDirectory), false);
  });

  it("returns a failed result without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPiSubagent({
      agent,
      task: "never run",
      cwd: process.cwd(),
      model: "provider/model:high",
      contextWindow: 100_000,
      signal: controller.signal,
    });

    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.thinking, "high");
    assert.equal(result.latestToolCall, undefined);
    assert.equal(result.usage.contextWindow, 100_000);
    assert.match(result.errorMessage ?? "", /aborted/);
  });
});

describe("subagent process diagnostics", () => {
  const zeroUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  function fakeSpawn(options: {
    stdout?: string[];
    stderr?: string[];
    error?: Error;
    close?: [number | null, NodeJS.Signals | null];
    onSpawn?: () => void;
    onInvocation?: (command: string, args: readonly string[]) => void;
    onKill?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  }) {
    return (command: string, args: string[]) => {
      options.onInvocation?.(command, args);
      const child = new EventEmitter() as unknown as ChildProcess;
      const anyChild = child as any;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      anyChild.stdout = stdout;
      anyChild.stderr = stderr;
      anyChild.pid = 4242;
      anyChild.exitCode = null;
      anyChild.signalCode = null;
      anyChild.kill = (signal: NodeJS.Signals) => { options.onKill?.(child, signal); return true; };
      setImmediate(() => {
        options.onSpawn?.();
        for (const chunk of options.stdout ?? []) stdout.emit("data", Buffer.from(chunk));
        for (const chunk of options.stderr ?? []) stderr.emit("data", Buffer.from(chunk));
        if (options.error) child.emit("error", options.error);
        if (options.close) child.emit("close", options.close[0], options.close[1]);
      });
      return child;
    };
  }

  function failedResult(overrides: Partial<AgentResult> = {}): AgentResult {
    return {
      agent: "test", task: "t", cwd: "/tmp", exitCode: 1, status: "failed",
      messages: [], stderr: "", usage: emptyTrackedUsage(), ...overrides,
    };
  }

  it("passes the delegated task through a private @file instead of argv", async () => {
    const task = `Review this change. ${"x".repeat(4_096)}`;
    let taskPath: string | undefined;
    let invocationArgs: readonly string[] | undefined;
    const result = await runPiSubagent(
      { agent: { ...agent, systemPrompt: "Keep these instructions" }, task, cwd: process.cwd() },
      {
        spawn: fakeSpawn({
          close: [0, null],
          onInvocation: (_command, args) => {
            invocationArgs = args;
            const taskArgument = args.find((arg) => arg.startsWith("@"));
            assert.ok(taskArgument);
            taskPath = taskArgument.slice(1);
            assert.equal(readFileSync(taskPath, "utf8"), `Task: ${task}`);
            assert.equal(statSync(taskPath).mode & 0o777, 0o600);
            assert.ok(args.includes("--append-system-prompt"));
            assert.ok(args.every((arg) => !arg.includes(task)));
          },
        }) as any,
      },
    );

    assert.equal(result.status, "done");
    assert.ok(invocationArgs);
    assert.ok(taskPath);
    assert.ok(invocationArgs.every((arg) => !arg.includes(task)));
    assert.equal(existsSync(taskPath), false);
  });

  it("classifies a silent nonzero exit and attaches process diagnostics", async () => {
    const result = await runPiSubagent(
      { agent, task: "fail silently", cwd: process.cwd() },
      { spawn: fakeSpawn({ close: [1, null] }) as any },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.process?.termination?.exitCode, 1);
    assert.equal(result.process?.termination?.signal, undefined);
    assert.match(resultOutput(result), /exited with code 1 before producing a Pi response/);
    assert.match(resultOutput(result), /0 messages/);
  });

  it("retains a termination signal instead of normalizing it to exit code 1", async () => {
    const result = await runPiSubagent(
      { agent, task: "killed", cwd: process.cwd() },
      { spawn: fakeSpawn({ close: [null, "SIGKILL"] }) as any },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.process?.termination?.signal, "SIGKILL");
    assert.equal(result.process?.termination?.exitCode, undefined);
    assert.match(resultOutput(result), /terminated by SIGKILL/);
  });

  it("classifies an unknown close (null code, no signal) as failed", async () => {
    const result = await runPiSubagent(
      { agent, task: "unknown", cwd: process.cwd() },
      { spawn: fakeSpawn({ close: [null, null] }) as any },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.process?.termination, undefined);
    assert.match(resultOutput(result), /ended before producing a Pi response/);
  });

  it("captures a bounded tail of unparsed and unrecognized stdout", async () => {
    const result = await runPiSubagent(
      { agent, task: "garbled", cwd: process.cwd() },
      { spawn: fakeSpawn({ stdout: ["not json\n", `${JSON.stringify({ type: "unknown" })}\n`, "still bad\n"], close: [1, null] }) as any },
    );
    assert.ok(result.process?.stdoutTail);
    assert.ok((result.process?.protocolErrors ?? 0) >= 2);
    assert.match(resultOutput(result), /unparsed stdout/);
  });

  it("keeps stderr as the primary error when present", () => {
    const result = failedResult({ stderr: "boom: broke", process: { termination: { exitCode: 1 } } });
    assert.equal(resultOutput(result), "boom: broke");
  });

  it("prefers an assistant error message over the process summary", () => {
    const result = failedResult({ errorMessage: "model blew up", process: { termination: { exitCode: 1 } } });
    assert.equal(resultOutput(result), "model blew up");
  });

  it("distinguishes parent cancellation from an external signal", async () => {
    const controller = new AbortController();
    const result = await runPiSubagent(
      { agent, task: "cancel me", cwd: process.cwd(), signal: controller.signal },
      {
        spawn: fakeSpawn({
          onSpawn: () => controller.abort(),
          onKill: (child, signal) => { if (signal === "SIGTERM") setImmediate(() => child.emit("close", null, signal)); },
        }) as any,
      },
    );
    assert.equal(result.status, "aborted");
    assert.equal(result.exitCode, 130);
    assert.equal(result.process?.termination?.signal, "SIGTERM");
    assert.equal(result.process?.termination?.escalatedToSigkill, undefined);
    assert.match(resultOutput(result), /aborted before producing/);
  });

  it("normalizes a clean child exit after cancellation to exit code 130", async () => {
    const controller = new AbortController();
    const result = await runPiSubagent(
      { agent, task: "cancel cleanly", cwd: process.cwd(), signal: controller.signal },
      {
        spawn: fakeSpawn({
          onSpawn: () => controller.abort(),
          onKill: (child, signal) => { if (signal === "SIGTERM") setImmediate(() => child.emit("close", 0, null)); },
        }) as any,
      },
    );
    assert.equal(result.status, "aborted");
    assert.equal(result.exitCode, 130);
    assert.equal(result.process?.termination?.exitCode, 0);
  });

  it("records SIGKILL escalation when SIGTERM does not stop the child", async () => {
    const controller = new AbortController();
    const result = await runPiSubagent(
      { agent, task: "ignore term", cwd: process.cwd(), signal: controller.signal },
      {
        escalationDelayMs: 0,
        spawn: fakeSpawn({
          onSpawn: () => controller.abort(),
          onKill: (child, signal) => { if (signal === "SIGKILL") setImmediate(() => child.emit("close", null, signal)); },
        }) as any,
      },
    );
    assert.equal(result.status, "aborted");
    assert.equal(result.process?.termination?.signal, "SIGKILL");
    assert.equal(result.process?.termination?.escalatedToSigkill, true);
  });

  it("terminates a settled child that remains alive and preserves its result", async () => {
    const signals: NodeJS.Signals[] = [];
    const message = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", api: "test", provider: "test", model: "m", usage: zeroUsage },
    });
    const result = await runPiSubagent(
      { agent, task: "settled but stuck", cwd: process.cwd() },
      {
        settlementDelayMs: 0,
        escalationDelayMs: 0,
        spawn: fakeSpawn({
          stdout: [`${message}\n`, `${JSON.stringify({ type: "agent_settled" })}\n`],
          onKill: (child, signal) => {
            signals.push(signal);
            if (signal === "SIGKILL") setImmediate(() => child.emit("close", null, signal));
          },
        }) as any,
      },
    );
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.process, undefined);
    assert.equal(resultOutput(result), "done");
  });

  it("does not kill a settled child that closes normally", async () => {
    const signals: NodeJS.Signals[] = [];
    const message = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", api: "test", provider: "test", model: "m", usage: zeroUsage },
    });
    const result = await runPiSubagent(
      { agent, task: "settled and done", cwd: process.cwd() },
      {
        settlementDelayMs: 0,
        spawn: fakeSpawn({
          stdout: [`${message}\n`, `${JSON.stringify({ type: "agent_settled" })}\n`],
          close: [0, null],
          onKill: (_child, signal) => signals.push(signal),
        }) as any,
      },
    );
    assert.deepEqual(signals, []);
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
    assert.equal(resultOutput(result), "done");
  });

  it("surfaces a spawn error as a distinct failure mode", async () => {
    const result = await runPiSubagent(
      { agent, task: "no binary", cwd: process.cwd() },
      { spawn: fakeSpawn({ error: new Error("spawn ENOENT") }) as any },
    );
    assert.equal(result.status, "spawn-error");
    assert.equal(result.process?.spawnError, "spawn ENOENT");
    assert.match(resultOutput(result), /failed to spawn: spawn ENOENT/);
  });

  it("bounds an unterminated stdout line while it is streaming", async () => {
    const stdout = Array.from({ length: 20 }, () => "y".repeat(128 * 1024));
    const totalBytes = stdout.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
    const result = await runPiSubagent(
      { agent, task: "unterminated flood", cwd: process.cwd() },
      { spawn: fakeSpawn({ stdout, close: [1, null] }) as any },
    );
    const tailBytes = Buffer.byteLength(result.process?.stdoutTail ?? "", "utf8");
    assert.ok(tailBytes <= 16 * 1024);
    assert.equal(result.process?.protocolErrors, 1);
    assert.equal((result.process?.stdoutBytesIgnored ?? 0) + tailBytes, totalBytes);
  });

  it("bounds captured stdout and stderr diagnostics", async () => {
    const result = await runPiSubagent(
      { agent, task: "flood", cwd: process.cwd() },
      { spawn: fakeSpawn({ stdout: [`${"y".repeat(1024 * 1024)}\n`], stderr: [`${"x".repeat(64 * 1024 + 100)}\n`], close: [1, null] }) as any },
    );
    assert.ok(Buffer.byteLength(result.process?.stdoutTail ?? "", "utf8") <= 16 * 1024);
    assert.ok((result.process?.stdoutBytesIgnored ?? 0) > 0);
    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024 + 64);
    assert.ok(result.stderr.includes("[earlier stderr truncated]"));
  });

  it("does not attach process diagnostics on success", async () => {
    const msg = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", api: "test", provider: "test", model: "m", usage: zeroUsage },
    });
    const result = await runPiSubagent(
      { agent, task: "ok", cwd: process.cwd() },
      { spawn: fakeSpawn({ stdout: [`${msg}\n`], close: [0, null] }) as any },
    );
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
    assert.equal(result.process, undefined);
    assert.equal(resultOutput(result), "done");
  });
});
