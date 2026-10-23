import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, childExtensionArgs } from "./launch.ts";
import { captureToolCalls, formatToolCall, newResult, resultOutput, type AgentResult } from "./process.ts";
import { defaultHandler, fakeRpcSpawn, type FakeRpcChild } from "./fake-rpc.ts";
import { runPiSubagent } from "./worker.ts";

const agent = {
  name: "test",
  description: "Test",
  systemPrompt: "",
  filePath: "/tmp/test.md",
};

describe("subagent process", () => {
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
    const result = newResult({ agent: "test", task: "inspect", cwd: "/tmp" });
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
      usage: result.usage.usage,
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
  });

  it("includes all tool arguments in the expanded-preview payload", () => {
    const command = `printf '%s' ${"x".repeat(200)}`;
    const preview = formatToolCall("bash", { command, timeout: 30, description: "full detail" });

    assert.match(preview, /^bash \{/);
    assert.ok(preview.includes(command));
    assert.match(preview, /"timeout": 30/);
    assert.match(preview, /"description": "full detail"/);
  });

  it("does not spawn when cancellation lands while the launch is prepared", async () => {
    const controller = new AbortController();
    const fake = fakeRpcSpawn();
    const running = runPiSubagent({
      agent: { ...agent, systemPrompt: "Instructions" },
      task: "cancel during launch",
      cwd: process.cwd(),
      model: "provider/model:HIGH",
      signal: controller.signal,
    }, { spawn: fake.spawn });
    controller.abort();
    const result = await running;

    assert.equal(fake.children.length, 0);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.thinking, "high");
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
    assert.equal(result.usage.contextWindow, 100_000);
    assert.match(result.errorMessage ?? "", /aborted/);
  });
});

describe("subagent process diagnostics", () => {
  /** Exit (or misbehave) before answering the readiness probe. */
  function failBeforeReady(action: (child: FakeRpcChild) => void) {
    return fakeRpcSpawn({ handler: (child, command) => { if (command.type === "get_state") action(child); } }).spawn;
  }

  it("launches an RPC child without a session and sends the task over stdin", async () => {
    const task = `Review this change. ${"x".repeat(4_096)}`;
    let promptPath: string | undefined;
    let invocationArgs: readonly string[] = [];
    const fake = fakeRpcSpawn({
      onSpawn: (_child, _command, args) => {
        invocationArgs = args;
        promptPath = args[args.indexOf("--append-system-prompt") + 1];
        assert.equal(readFileSync(promptPath, "utf8"), "Keep these instructions");
        assert.equal(statSync(promptPath).mode & 0o777, 0o600);
      },
    });
    const result = await runPiSubagent(
      { agent: { ...agent, systemPrompt: "Keep these instructions" }, task, cwd: process.cwd(), environment: { TEST_HANDOFF: "snapshot" } },
      { spawn: fake.spawn },
    );

    assert.equal(result.status, "done");
    assert.equal(resultOutput(result), `done: Task: ${task}`);
    assert.ok(invocationArgs.includes("--mode") && invocationArgs.includes("rpc") && invocationArgs.includes("--no-session"));
    assert.ok(invocationArgs.every((arg) => !arg.includes(task)));
    assert.ok(promptPath);
    assert.equal(existsSync(promptPath), false);
    assert.equal(fake.children[0].commands.find((command) => command.type === "prompt").message, `Task: ${task}`);
    assert.equal(fake.children[0].stdinEnded, true);
  });

  it("marks the child and passes launch-scoped environment", async () => {
    let env: NodeJS.ProcessEnv = {};
    const fake = fakeRpcSpawn();
    const spawn = (command: string, args: string[], options: any) => {
      env = options.env;
      return fake.spawn(command, args, options);
    };
    await runPiSubagent(
      { agent, task: "env", cwd: process.cwd(), environment: { TEST_HANDOFF: "snapshot", [SUBAGENT_CHILD_ENV]: "wrong" } },
      { spawn: spawn as any },
    );
    assert.equal(env.TEST_HANDOFF, "snapshot");
    assert.equal(env[SUBAGENT_CHILD_ENV], "1");
  });

  for (const { name, exit, signal, expected } of [
    { name: "a silent nonzero exit", exit: 1, signal: null, expected: /exited with code 1 before producing a Pi response \(0 messages/ },
    { name: "a termination signal", exit: null, signal: "SIGKILL" as const, expected: /terminated by SIGKILL/ },
    { name: "an unknown close", exit: null, signal: null, expected: /ended before producing a Pi response/ },
  ]) {
    it(`classifies ${name} before the child is ready`, async () => {
      const result = await runPiSubagent({ agent, task: name, cwd: process.cwd() }, { spawn: failBeforeReady((child) => child.close(exit, signal)) });
      assert.equal(result.status, "failed");
      assert.equal(result.process?.termination?.exitCode, exit ?? undefined);
      assert.equal(result.process?.termination?.signal, signal ?? undefined);
      assert.match(resultOutput(result), expected);
    });
  }

  it("captures a bounded tail of unparsed stdout", async () => {
    const spawn = failBeforeReady((child) => {
      child.emitRaw("not json\nstill bad\n");
      child.close(1);
    });
    const result = await runPiSubagent({ agent, task: "garbled", cwd: process.cwd() }, { spawn });
    assert.equal(result.process?.stdoutTail, "not json\nstill bad\n");
    assert.equal(result.process?.protocolErrors, 2);
    assert.match(resultOutput(result), /unparsed stdout/);
  });

  it("skips oversized records without treating them as errors", async () => {
    const huge = JSON.stringify({ type: "agent_end", messages: ["x".repeat(9 * 1024 * 1024)] });
    const fake = fakeRpcSpawn({
      handler: (child, command) => {
        if (command.type !== "prompt") return defaultHandler(child, command);
        child.respond(command, { disposition: "started" });
        child.emitRaw(`${huge.slice(0, huge.length / 2)}`);
        child.emitRaw(`${huge.slice(huge.length / 2)}\n`);
        child.finishRun("after the flood");
      },
    });
    const result = await runPiSubagent({ agent, task: "flood", cwd: process.cwd() }, { spawn: fake.spawn });
    assert.equal(result.status, "done");
    assert.equal(resultOutput(result), "after the flood");
  });

  for (const { name, fields, expected } of [
    { name: "stderr", fields: { stderr: "boom: broke" }, expected: "boom: broke" },
    { name: "an assistant error message", fields: { errorMessage: "model blew up", stderr: "noise" }, expected: "model blew up" },
  ]) {
    it(`reports ${name} ahead of the process summary`, () => {
      const result: AgentResult = newResult({ agent: "test", task: "t", cwd: "/tmp" }, { exitCode: 1, status: "failed", process: { termination: { exitCode: 1 } }, ...fields });
      assert.equal(resultOutput(result), expected);
    });
  }

  for (const { name, onKill, escalationDelayMs, termination } of [
    {
      name: "records parent cancellation and the SIGTERM that stopped the child",
      onKill: (child: FakeRpcChild, signal: NodeJS.Signals) => { if (signal === "SIGTERM") setImmediate(() => child.close(null, signal)); },
      escalationDelayMs: undefined,
      termination: { signal: "SIGTERM" },
    },
    {
      name: "normalizes a clean child exit after cancellation to exit code 130",
      onKill: (child: FakeRpcChild, signal: NodeJS.Signals) => { if (signal === "SIGTERM") setImmediate(() => child.close(0)); },
      escalationDelayMs: undefined,
      termination: { exitCode: 0 },
    },
    {
      name: "records SIGKILL escalation when SIGTERM does not stop the child",
      onKill: (child: FakeRpcChild, signal: NodeJS.Signals) => { if (signal === "SIGKILL") setImmediate(() => child.close(null, signal)); },
      escalationDelayMs: 0,
      termination: { signal: "SIGKILL", escalatedToSigkill: true },
    },
  ]) {
    it(name, async () => {
      const controller = new AbortController();
      const spawn = fakeRpcSpawn({
        handler: (child, command) => {
          if (command.type !== "prompt") return defaultHandler(child, command);
          child.respond(command, { disposition: "started" });
          controller.abort();
        },
        onKill,
      }).spawn;
      const result = await runPiSubagent({ agent, task: "cancel me", cwd: process.cwd(), signal: controller.signal }, { spawn, escalationDelayMs });
      assert.equal(result.status, "aborted");
      assert.equal(result.exitCode, 130);
      assert.deepEqual(result.process?.termination, termination);
      assert.match(resultOutput(result), /aborted/);
    });
  }

  it("escalates a finished child that ignores stdin EOF and keeps its result", async () => {
    const fake = fakeRpcSpawn({
      handler: (child, command) => { if (command.type !== "<eof>") defaultHandler(child, command); },
      onKill: (child, signal) => { if (signal === "SIGKILL") setImmediate(() => child.close(null, signal)); },
    });
    const result = await runPiSubagent(
      { agent, task: "settled but stuck", cwd: process.cwd() },
      { spawn: fake.spawn, shutdownGraceMs: 0, escalationDelayMs: 0 },
    );
    assert.deepEqual(fake.children[0].signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.status, "done");
    assert.equal(result.process, undefined);
    assert.equal(resultOutput(result), "done: Task: settled but stuck");
  });

  it("does not signal a finished child that exits on stdin EOF", async () => {
    const fake = fakeRpcSpawn();
    const result = await runPiSubagent({ agent, task: "settled and done", cwd: process.cwd() }, { spawn: fake.spawn });
    assert.deepEqual(fake.children[0].signals, []);
    assert.equal(result.status, "done");
    assert.equal(result.process, undefined);
  });

  it("reports a model error as a failed but completed run", async () => {
    const fake = fakeRpcSpawn({
      handler: (child, command) => {
        if (command.type !== "prompt") return defaultHandler(child, command);
        child.respond(command, { disposition: "started" });
        child.finishRun("", { stopReason: "error", errorMessage: "rate limited" });
      },
    });
    const result = await runPiSubagent({ agent, task: "model fails", cwd: process.cwd() }, { spawn: fake.spawn });
    assert.equal(result.status, "done");
    assert.equal(result.stopReason, "error");
    assert.equal(resultOutput(result), "rate limited");
  });

  it("surfaces a spawn error as a distinct failure mode", async () => {
    const fake = fakeRpcSpawn({ onSpawn: (child) => setImmediate(() => child.emit("error", new Error("spawn ENOENT"))), handler: () => {} });
    const result = await runPiSubagent({ agent, task: "no binary", cwd: process.cwd() }, { spawn: fake.spawn });
    assert.equal(result.status, "spawn-error");
    assert.equal(result.process?.spawnError, "spawn ENOENT");
    assert.match(resultOutput(result), /failed to spawn: spawn ENOENT/);
  });

  it("bounds captured stderr", async () => {
    const spawn = failBeforeReady((child) => {
      child.stderr.emit("data", Buffer.from(`${"x".repeat(64 * 1024 + 100)}\n`));
      child.close(1);
    });
    const result = await runPiSubagent({ agent, task: "flood", cwd: process.cwd() }, { spawn });
    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024 + 64);
    assert.ok(result.stderr.includes("[earlier stderr truncated]"));
  });

  it("answers worker extension dialogs as cancelled", async () => {
    const fake = fakeRpcSpawn({
      handler: (child, command) => {
        if (command.type !== "prompt") return defaultHandler(child, command);
        child.respond(command, { disposition: "started" });
        child.emitRecord({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["a"] });
        child.emitRecord({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "Sure?", message: "?" });
        child.finishRun();
      },
    });
    await runPiSubagent({ agent, task: "dialogs", cwd: process.cwd() }, { spawn: fake.spawn });
    const responses = fake.children[0].commands.filter((command) => command.type === "extension_ui_response");
    assert.deepEqual(responses, [
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
      { type: "extension_ui_response", id: "ui-2", cancelled: true },
    ]);
  });
});
