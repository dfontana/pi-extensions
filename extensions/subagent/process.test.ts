import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPiSubagent } from "./process.ts";

const agent = {
  name: "test",
  description: "Test",
  systemPrompt: "",
  filePath: "/tmp/test.md",
};

describe("subagent process", () => {
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
