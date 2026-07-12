import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { canonicalModel, selectReviewModel, type ReviewIntelligencePreference, type ReviewThinkingLevel } from "./selector.ts";

describe("review-model-selector selector", () => {
  function model(
    provider: string,
    id: string,
    options: Partial<Model<Api>> & { name?: string; contextWindow?: number } = {},
  ): Model<Api> {
    return {
      id,
      name: options.name ?? id,
      api: options.api ?? "openai-responses",
      provider,
      baseUrl: options.baseUrl ?? "https://example.test",
      reasoning: options.reasoning ?? true,
      thinkingLevelMap: options.thinkingLevelMap,
      input: options.input ?? ["text"],
      cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options.contextWindow ?? 200_000,
      maxTokens: options.maxTokens ?? 16_384,
      headers: options.headers,
      compat: options.compat,
    } as Model<Api>;
  }

  const sol = model("ai-gw-openai", "openai/gpt-5.6-sol");
  const terra = model("ai-gw-openai", "openai/gpt-5.6-terra");
  const luna = model("ai-gw-openai", "openai/gpt-5.6-luna");
  const opus200k = model("ai-gw-anthropic-200k", "anthropic/claude-opus-4-8", { contextWindow: 200_000 });
  const opus1m = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-8", { contextWindow: 1_000_000 });
  const sonnet = model("ai-gw-anthropic-1m", "anthropic/claude-sonnet-4-6", { contextWindow: 1_000_000 });

  function select(
    current: Model<Api>,
    available: Model<Api>[],
    options: { thinking?: ReviewThinkingLevel; intelligencePreference?: ReviewIntelligencePreference; minimumContextWindow?: number } = {},
  ) {
    return selectReviewModel({ current, available, thinking: options.thinking ?? "high", ...options });
  }

  test("selects a reviewer at the requested intelligence level", () => {
    const cases = [
      { name: "higher tier", current: luna, available: [luna, terra, sonnet, opus1m, sol], expected: opus1m },
      { name: "same-tier peer", current: sonnet, available: [sonnet, sol, terra], preference: "same" as const, expected: terra },
      { name: "current model when no eligible peer exists", current: sol, available: [sol, terra], expected: sol },
      { name: "current model when same-tier peers are absent", current: sol, available: [sol, terra], preference: "same" as const, expected: sol },
    ];

    for (const { name, current, available, preference, expected } of cases) {
      const result = select(current, available, { intelligencePreference: preference });
      assert.equal(canonicalModel(result.selected), canonicalModel(expected), name);
    }
  });

  test("filters candidates that do not meet the observable eligibility contract", () => {
    const unknown = model("custom", "acme/reviewer-ultra");
    const displayNameOnly = model("openrouter", "google/gemini-3-pro-image", { name: "Google: Nano Banana Pro" });
    const result = select(sol, [sol, unknown, displayNameOnly]);
    assert.equal(canonicalModel(result.selected), canonicalModel(sol));

    const contextLimited = select(sonnet, [sonnet, opus200k, opus1m], { minimumContextWindow: 1_000_000 });
    assert.equal(canonicalModel(contextLimited.selected), canonicalModel(opus1m));
  });

  test("uses stable tie-breakers without sacrificing reviewer diversity", () => {
    const newer = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-7", { contextWindow: 1_000_000 });
    const dated = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-20250514", { contextWindow: 1_000_000 });
    const versionResult = select(sol, [sol, dated, newer, opus1m]);
    assert.equal(canonicalModel(versionResult.selected), canonicalModel(opus1m));

    const contextResult = select(sol, [sol, opus200k, opus1m]);
    assert.equal(canonicalModel(contextResult.selected), canonicalModel(opus1m));

    const direct = model("openai-codex", "gpt-5.6-sol", { contextWindow: 400_000 });
    const aggregator = model("openrouter", "openai/gpt-5.6-sol", { contextWindow: 400_000 });
    assert.equal(canonicalModel(select(aggregator, [aggregator, direct]).selected), canonicalModel(direct));
    assert.equal(canonicalModel(select(direct, [direct, aggregator]).selected), canonicalModel(direct));
  });

  test("reports the selection outcome", () => {
    const higher = select(luna, [luna, terra]);
    assert.match(higher.reason, /higher-ranked model/);

    const peer = select(sol, [sol, opus1m]);
    assert.match(peer.reason, /equal-ranked peer/);

    const reused = select(sol, [sol]);
    assert.match(reused.reason, /reused the current session model/);
  });

  test("rejects missing or unrecognized session models", () => {
    const unknown = model("custom", "acme/reviewer-ultra");
    assert.throws(
      () => selectReviewModel({ current: undefined, available: [sol], thinking: "high" }),
      /No active session model/,
    );
    assert.throws(() => select(unknown, [unknown, sol]), /unrecognized intelligence tier/);
  });
});
