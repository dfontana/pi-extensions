import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import {
  captureToolCalls,
  childExtensionArgs,
  formatToolCall,
  childProcessEnvironment,
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
