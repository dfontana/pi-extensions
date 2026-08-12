import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

interface RegisteredTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<any>;
}

describe("model-query index", () => {
  function model(provider: string, id: string): Model<Api> {
    return {
      id,
      name: id,
      api: "openai-responses",
      provider,
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    } as Model<Api>;
  }

  test("derives runtime state privately and refreshes once per call", async () => {
    let tool: RegisteredTool | undefined;
    extension({ registerTool: (registered: RegisteredTool) => (tool = registered) } as unknown as ExtensionAPI);
    assert.ok(tool);
    assert.equal(tool.name, "model_query");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
      "excludeCurrentVendor",
      "intelligence",
      "minimumContextWindow",
      "model",
      "thinking",
    ]);

    const current = model("openai-codex", "gpt-5.6-sol");
    const peer = model("anthropic", "claude-sonnet-4-6");
    let refreshes = 0;
    const result = await tool.execute(
      "call",
      { intelligence: "same", thinking: "high" },
      undefined,
      undefined,
      {
        model: current,
        modelRegistry: {
          refresh: async () => {
            refreshes += 1;
          },
          getAvailable: () => [current, peer],
        },
      },
    );

    assert.equal(refreshes, 1);
    assert.deepEqual(result.details, { model: "openai-codex/gpt-5.6-sol", thinking: "high" });
    assert.equal(result.content[0].text, JSON.stringify(result.details, null, 2));
  });

  test("does not accept caller-supplied registry or active-model parameters", () => {
    let tool: RegisteredTool | undefined;
    extension({ registerTool: (registered: RegisteredTool) => (tool = registered) } as unknown as ExtensionAPI);
    assert.ok(tool);
    assert.equal("current" in tool.parameters.properties, false);
    assert.equal("available" in tool.parameters.properties, false);
    assert.equal("vendor" in tool.parameters.properties, false);
  });
});
