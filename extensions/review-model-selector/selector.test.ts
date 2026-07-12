import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { canonicalModel, rankModel, selectReviewModel, type ReviewIntelligencePreference, type ReviewThinkingLevel } from "./selector.ts";

describe("review-model-selector", () => {

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
const mini = model("ai-gw-openai", "openai/gpt-5.4-mini");
const opus200k = model("ai-gw-anthropic-200k", "anthropic/claude-opus-4-8", { contextWindow: 200_000 });
const opus1m = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-8", { contextWindow: 1_000_000 });
const sonnet = model("ai-gw-anthropic-1m", "anthropic/claude-sonnet-4-6", { contextWindow: 1_000_000 });

function select(
  current: Model<Api>,
  available: Model<Api>[],
  thinking: ReviewThinkingLevel = "high",
  intelligencePreference?: ReviewIntelligencePreference,
) {
  return selectReviewModel({ current, available, thinking, intelligencePreference });
}

test("uses the configured intelligence tiers", () => {
  assert.equal(rankModel(sol)?.rank, rankModel(opus1m)?.rank);
  assert.equal(rankModel(terra)?.rank, rankModel(sonnet)?.rank);
  assert.ok(rankModel(sol)!.rank > rankModel(terra)!.rank);
  assert.ok(rankModel(terra)!.rank > rankModel(luna)!.rank);
  assert.ok(rankModel(luna)!.rank > rankModel(mini)!.rank);
});

test("prefers a higher-ranked model", () => {
  const result = select(luna, [luna, terra, sonnet, opus1m, sol]);
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
  assert.match(result.reason, /higher-ranked model/);
});

test("uses the largest-context route when equal candidates share a model", () => {
  const result = select(sol, [sol, opus200k, opus1m]);
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
});

test("prefers the newest version within one vendor and tier", () => {
  const opus46 = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-6", { contextWindow: 1_000_000 });
  const opus47 = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-7", { contextWindow: 1_000_000 });
  const result = select(sol, [sol, opus46, opus47, opus1m]);
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
});

test("treats dated Claude 4 IDs as version 4.0 rather than huge minor versions", () => {
  const datedOpus4 = model("ai-gw-anthropic-1m", "anthropic/claude-opus-4-20250514", { contextWindow: 1_000_000 });
  const result = select(sol, [sol, datedOpus4, opus1m]);
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
});

test("falls back to an equal-ranked peer before the current model", () => {
  const result = select(sol, [sol, opus1m]);
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
  assert.match(result.reason, /equal-ranked peer/);
});

test("does not treat an aggregator route to the current model as a peer", () => {
  const codexSol = model("openai-codex", "gpt-5.6-sol", { contextWindow: 400_000 });
  const openrouterSol = model("openrouter", "openai/gpt-5.6-sol", { contextWindow: 400_000 });
  const result = select(codexSol, [codexSol, openrouterSol]);
  assert.equal(canonicalModel(result.selected), canonicalModel(codexSol));
  assert.match(result.reason, /reused the current session model/);
});

test("switches to the direct route when the session runs through an aggregator", () => {
  const codexSol = model("openai-codex", "gpt-5.6-sol", { contextWindow: 400_000 });
  const openrouterSol = model("openrouter", "openai/gpt-5.6-sol", { contextWindow: 400_000 });
  const result = select(openrouterSol, [openrouterSol, codexSol]);
  assert.equal(canonicalModel(result.selected), canonicalModel(codexSol));
  assert.match(result.reason, /direct route/);
});

test("reuses a direct-route current model over aggregator-only distinct peers", () => {
  const codexSol = model("openai-codex", "gpt-5.6-sol", { contextWindow: 400_000 });
  const openrouterSolPro = model("openrouter", "openai/gpt-5.6-sol-pro", { contextWindow: 400_000 });
  const openrouterOpus = model("openrouter", "anthropic/claude-opus-4-8", { contextWindow: 1_000_000 });
  const result = select(codexSol, [codexSol, openrouterSolPro, openrouterOpus]);
  assert.equal(canonicalModel(result.selected), canonicalModel(codexSol));
});

test("prefers a direct-provider peer over an aggregator peer with more context", () => {
  const codexSol = model("openai-codex", "gpt-5.6-sol", { contextWindow: 400_000 });
  const openrouterOpus = model("openrouter", "anthropic/claude-opus-4-8", { contextWindow: 1_000_000 });
  const result = select(luna, [luna, codexSol, openrouterOpus]);
  assert.equal(canonicalModel(result.selected), canonicalModel(codexSol));
  assert.match(result.reason, /higher-ranked model/);
});

test("reuses the current model when it is the only eligible peer", () => {
  const result = select(sol, [sol, terra]);
  assert.equal(canonicalModel(result.selected), canonicalModel(sol));
  assert.match(result.reason, /reused the current session model/);
});

test("same intelligence preference restricts to equal-ranked models", () => {
  const result = select(sonnet, [sonnet, sol, terra], "high", "same");
  assert.equal(canonicalModel(result.selected), canonicalModel(terra));
  assert.match(result.reason, /equal-ranked peer/);
});

test("same intelligence preference falls back to current model when no peer exists", () => {
  const result = select(sol, [sol, terra], "high", "same");
  assert.equal(canonicalModel(result.selected), canonicalModel(sol));
  assert.match(result.reason, /reused the current session model/);
});

test("minimumContextWindow filters auto-selected candidates", () => {
  const result = selectReviewModel({
    current: sonnet,
    available: [sonnet, opus200k, opus1m],
    thinking: "high",
    minimumContextWindow: 1_000_000,
  });
  assert.equal(canonicalModel(result.selected), canonicalModel(opus1m));
  assert.match(result.reason, /higher-ranked model/);
});

test("excludes candidates with an unknown tier", () => {
  const unknown = model("custom", "acme/reviewer-ultra");
  const result = select(sol, [sol, unknown]);
  assert.equal(canonicalModel(result.selected), canonicalModel(sol));
});

test("does not infer tiers from unrelated display-name branding", () => {
  const nanoBanana = model("openrouter", "google/gemini-3-pro-image", {
    name: "Google: Nano Banana Pro",
  });
  assert.equal(rankModel(nanoBanana), undefined);
  const result = select(sol, [sol, nanoBanana]);
  assert.equal(canonicalModel(result.selected), canonicalModel(sol));
});

test("refuses to guess when the current model tier is unknown", () => {
  const unknown = model("custom", "acme/reviewer-ultra");
  assert.throws(() => select(unknown, [unknown, sol]), /unrecognized intelligence tier/);
});

});
