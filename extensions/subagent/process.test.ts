import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureToolCalls,
  childExtensionArgs,
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

  it("keeps bounded visible tool activity independent of transcript eviction", () => {
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
    result.messages = [];
    captureToolCalls(result, {
      ...message,
      content: [{ type: "toolCall", id: "later", name: "grep", arguments: { pattern: "later", path: "/tmp" } }],
    });

    assert.equal(result.toolCalls?.length, 200);
    assert.equal(result.toolCalls?.[0], "read /tmp/file-0.ts");
    assert.equal(result.toolCalls?.at(-1), "read /tmp/file-199.ts");
    assert.equal(result.omittedToolCalls, 6);
  });

  it("returns a failed result without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPiSubagent({
      agent,
      task: "never run",
      cwd: process.cwd(),
      signal: controller.signal,
    });

    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.match(result.errorMessage ?? "", /aborted/);
  });
});
