import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import processSubagents from "./index.ts";
import { CHILD_MARKER } from "./contracts.ts";

function harness() {
  const tools: ToolDefinition[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => hooks.push(name),
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, hooks };
}

describe("process-subagents", () => {
  test("registers exactly the four public delegation tools and view-only command", () => {
    const { pi, tools, commands, hooks } = harness();
    processSubagents(pi);
    assert.deepEqual(tools.map((tool) => tool.name), ["Agent", "resume_subagent", "get_subagent_result", "stop_subagent"]);
    assert.deepEqual(commands, ["agents"]);
    assert.ok(hooks.includes("session_start"));
    assert.ok(hooks.includes("session_before_tree"));
    assert.ok(hooks.includes("before_agent_start"));
    assert.ok(hooks.includes("session_shutdown"));
  });

  test("registers nothing recursively in marked child processes", () => {
    const previous = process.env[CHILD_MARKER];
    process.env[CHILD_MARKER] = "1";
    try {
      const { pi, tools, commands, hooks } = harness();
      processSubagents(pi);
      assert.deepEqual({ tools, commands, hooks }, { tools: [], commands: [], hooks: [] });
    } finally {
      if (previous === undefined) delete process.env[CHILD_MARKER];
      else process.env[CHILD_MARKER] = previous;
    }
  });

  test("rejects Agent calls from ephemeral parent sessions before spawning", async () => {
    const { pi, tools } = harness();
    processSubagents(pi);
    const agent = tools.find((tool) => tool.name === "Agent")!;
    const ctx = { sessionManager: { getSessionFile: () => undefined } } as any;
    await assert.rejects(
      agent.execute("call", { prompt: "x", description: "x", subagent_type: "Explore" }, undefined, undefined, ctx),
      /persisted parent session/,
    );
  });
});
