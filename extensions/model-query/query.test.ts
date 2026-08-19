import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  canonicalModel,
  classifyModelRoute,
  detectModelVendor,
  modelTier,
  resolveModelQuery,
  resolveModelReference,
} from "./query.ts";

describe("model-query query", () => {
  function model(
    provider: string,
    id: string,
    options: Partial<Model<Api>> & { contextWindow?: number } = {},
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

  const sol = model("openai-codex", "gpt-5.6-sol");
  const solRoute = model("openrouter", "openai/gpt-5.6-sol");
  const terra = model("anthropic", "claude-sonnet-4-6");
  const luna = model("openrouter", "google/gemini-3-luna");
  const opus = model("anthropic", "claude-opus-4-8");

  test("uses exact canonical and raw IDs without inventing models", () => {
    assert.deepEqual(resolveModelQuery({ available: [sol], model: "OPENAI-CODEX/GPT-5.6-SOL" }), {
      model: canonicalModel(sol),
    });
    assert.deepEqual(resolveModelQuery({ available: [sol], model: "gpt-5.6-sol" }), { model: canonicalModel(sol) });
    assert.throws(() => resolveModelQuery({ available: [sol], model: "missing-model" }), /not available/);
    assert.throws(() => resolveModelQuery({ available: [sol], model: "higher" }), /not available/);
  });

  test("resolves Pi-style fuzzy short names and ranks ambiguous routes deterministically", () => {
    assert.equal(resolveModelQuery({ available: [sol, terra], model: "gpt56sol" }).model, canonicalModel(sol));
    assert.equal(resolveModelQuery({ available: [solRoute, sol] }).model, canonicalModel(sol));
    assert.equal(resolveModelQuery({ available: [sol, solRoute].reverse() }).model, canonicalModel(sol));
    assert.equal(resolveModelQuery({ available: [sol], model: "GPT-5.6-SOL" }).model, canonicalModel(sol));
    assert.throws(() => resolveModelQuery({ available: [sol], model: "Google Nano Banana Pro" }), /not available/);
  });

  test("always ranks direct routes ahead of aggregators", () => {
    const directSonnet = model("anthropic", "claude-sonnet-4-6");
    const aggregatorOpus = model("openrouter", "anthropic/claude-opus-4-8");

    assert.equal(resolveModelQuery({ available: [aggregatorOpus, directSonnet] }).model, canonicalModel(directSonnet));
    assert.equal(
      resolveModelQuery({ current: luna, available: [aggregatorOpus, directSonnet], intelligence: "higher" }).model,
      canonicalModel(directSonnet),
    );
  });

  test("applies relative tier, peer diversity, thinking, and context policy", () => {
    assert.equal(resolveModelQuery({ current: luna, available: [luna, terra, opus], intelligence: "higher" }).model, canonicalModel(opus));
    const sonnetPeer = model("anthropic", "claude-sonnet-4-7");
    assert.equal(resolveModelQuery({ current: terra, available: [terra, sonnetPeer], intelligence: "same" }).model, canonicalModel(sonnetPeer));
    assert.equal(resolveModelQuery({ current: sol, available: [sol, terra], intelligence: "higher" }).model, canonicalModel(sol));
    assert.equal(resolveModelQuery({ current: sol, available: [sol, terra], intelligence: "lower" }).model, canonicalModel(terra));

    const solPeer = model("openai-codex", "gpt-5.7-sol");
    assert.equal(resolveModelQuery({ current: sol, available: [sol, solPeer], intelligence: "lower" }).model, canonicalModel(solPeer));
    assert.equal(resolveModelQuery({ current: sol, available: [sol], intelligence: "lower" }).model, canonicalModel(sol));

    const lowerLuna = model("openrouter", "google/gemini-3-luna", {
      contextWindow: 100_000,
      thinkingLevelMap: { max: "supported" },
    });
    assert.deepEqual(
      resolveModelQuery({
        current: sol,
        available: [sol, lowerLuna],
        model: "luna",
        intelligence: "lower",
        thinking: "max",
        minimumContextWindow: 100_000,
      }),
      { model: canonicalModel(lowerLuna), thinking: "max" },
    );
    assert.throws(
      () => resolveModelQuery({ current: luna, available: [luna, terra], model: canonicalModel(terra), intelligence: "lower" }),
      /No eligible/,
    );

    const noMax = model("anthropic", "claude-opus-4-8", { thinkingLevelMap: { max: null } });
    const maxSol = model("openai-codex", "gpt-5.6-sol", { thinkingLevelMap: { max: "supported" } });
    assert.equal(resolveModelQuery({ available: [noMax, maxSol], thinking: "max" }).model, canonicalModel(maxSol));
    assert.deepEqual(resolveModelQuery({ available: [sol], thinking: "high" }), { model: canonicalModel(sol), thinking: "high" });
    assert.throws(() => resolveModelQuery({ available: [noMax], thinking: "max" }), /No eligible/);
    const largeOpus = model("anthropic", "claude-opus-4-8", { contextWindow: 500_000 });
    assert.equal(resolveModelQuery({ available: [sol, largeOpus], minimumContextWindow: 300_000 }).model, canonicalModel(largeOpus));
  });

  test("keeps vendor identity separate from serving routes", () => {
    assert.equal(detectModelVendor(solRoute), "openai");
    assert.equal(detectModelVendor(terra), "anthropic");
    assert.equal(detectModelVendor(luna), "google");
    assert.equal(detectModelVendor("meta-llama/llama-4"), "meta");
    assert.equal(detectModelVendor("vendor/custom-ultra"), undefined);
    assert.equal(classifyModelRoute("openrouter"), "aggregator");
    assert.equal(classifyModelRoute("openai"), "direct");

    const anotherOpenAi = model("openrouter", "openai/gpt-5.7-sol");
    assert.equal(
      resolveModelQuery({ current: sol, available: [sol, solRoute, anotherOpenAi, terra], excludeCurrentVendor: true }).model,
      canonicalModel(terra),
    );
    assert.throws(
      () => resolveModelQuery({ current: model("custom", "custom-ultra"), available: [opus], excludeCurrentVendor: true }),
      /unknown vendor/,
    );
  });

  test("supports unknown-tier exact models but rejects them for relative selection", () => {
    const custom = model("custom", "vendor/custom-ultra");
    assert.equal(resolveModelQuery({ available: [custom], model: "custom/vendor/custom-ultra" }).model, canonicalModel(custom));
    assert.equal(modelTier(custom), undefined);
    assert.throws(() => resolveModelQuery({ current: custom, available: [custom], intelligence: "higher" }), /unrecognized/);
  });

  test("compares versions, release dates, context, and canonical identity independent of order", () => {
    const old = model("anthropic", "claude-opus-4-7", { contextWindow: 1_000_000 });
    const dated = model("anthropic", "claude-opus-4-20250514", { contextWindow: 1_000_000 });
    const newer = model("anthropic", "claude-opus-4-8", { contextWindow: 1_000_000 });
    assert.equal(resolveModelQuery({ available: [old, dated, newer] }).model, canonicalModel(newer));

    const small = model("anthropic", "claude-opus-4-8", { contextWindow: 200_000 });
    const large = model("anthropic", "claude-opus-4-8", { contextWindow: 1_000_000 });
    assert.equal(resolveModelQuery({ available: [small, large] }).model, canonicalModel(large));
  });

  test("honors explicit thinking suffixes and explicit thinking precedence", () => {
    const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of levels) {
      const candidate = model("openai-codex", `gpt-5.6-sol-${level}`, {
        thinkingLevelMap: { [level]: "supported" },
      });
      assert.equal(resolveModelReference(`${canonicalModel(candidate)}:${level}`, { available: [candidate] }).thinking, level);
    }
    const candidate = model("openai-codex", "gpt-5.6-sol", { thinkingLevelMap: { high: "supported", low: "supported" } });
    assert.equal(resolveModelReference(`${canonicalModel(candidate)}:high`, { available: [candidate] }, "low").thinking, "low");
    assert.equal(resolveModelReference(`${canonicalModel(candidate)}:HIGH`, { available: [candidate] }).thinking, "high");
  });

  test("rejects invalid context windows consistently with the tool schema", () => {
    assert.throws(() => resolveModelQuery({ available: [sol], minimumContextWindow: 0 }), /at least 1/);
  });
});
