import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

interface RegisteredTool {
  execute: (...args: any[]) => Promise<any>;
}

describe("review-model-selector index", () => {
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

  test("passes the tool cancellation signal to registry refresh", async () => {
    let tool: RegisteredTool | undefined;
    extension({ registerTool: (registered: RegisteredTool) => (tool = registered) } as unknown as ExtensionAPI);
    assert.ok(tool);

    const current = model("openai-codex", "gpt-5.6-sol");
    const peer = model("anthropic", "claude-sonnet-4-6");
    const controller = new AbortController();
    let refreshSignal: AbortSignal | undefined;

    const result = await tool.execute(
      "call",
      { intelligence: "same", thinking: "high" },
      controller.signal,
      undefined,
      {
        model: current,
        modelRegistry: {
          refresh: async (options: { signal?: AbortSignal }) => {
            refreshSignal = options.signal;
            return { aborted: false, errors: new Map() };
          },
          getAvailable: () => [current, peer],
        },
      },
    );

    assert.equal(refreshSignal, controller.signal);
    assert.equal(result.details.model, "openai-codex/gpt-5.6-sol");
    assert.equal(result.details.thinking, "high");
  });

  test("stops before selecting a reviewer when refresh is aborted", async () => {
    let tool: RegisteredTool | undefined;
    extension({ registerTool: (registered: RegisteredTool) => (tool = registered) } as unknown as ExtensionAPI);
    assert.ok(tool);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tool.execute(
        "call",
        { intelligence: "same" },
        controller.signal,
        undefined,
        {
          model: model("openai-codex", "gpt-5.6-sol"),
          modelRegistry: {
            refresh: async () => ({ aborted: true, errors: new Map() }),
            getAvailable: () => [],
          },
        },
      ),
    );
  });
});
