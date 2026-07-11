import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lookupRates, normalizeSlug, type PricingIndex, type Rates } from "./index.ts";

function rates(prompt: number, completion: number): Rates {
  return { prompt, completion, cacheRead: prompt * 0.1, cacheWrite: prompt * 1.25 };
}

function buildIndex(entries: Array<[id: string, r: Rates]>): PricingIndex {
  const byId = new Map<string, Rates>();
  const byBase = new Map<string, Array<{ id: string; author: string; rates: Rates }>>();
  for (const [id, r] of entries) {
    const norm = normalizeSlug(id);
    byId.set(norm, r);
    if (norm.includes(":")) continue;
    const slash = norm.lastIndexOf("/");
    const author = slash >= 0 ? norm.slice(0, slash) : "";
    const base = slash >= 0 ? norm.slice(slash + 1) : norm;
    let list = byBase.get(base);
    if (!list) byBase.set(base, (list = []));
    list.push({ id: norm, author, rates: r });
  }
  return { byId, byBase };
}

const anthropic = rates(3e-6, 15e-6);
const reseller = rates(1e-6, 5e-6);
const openai = rates(1.25e-6, 10e-6);

const index = buildIndex([
  ["anthropic/claude-sonnet-5", anthropic],
  ["some-reseller/claude-sonnet-5", reseller],
  ["openai/gpt-5.2", openai],
  ["anthropic/claude-haiku-4.5", rates(1e-6, 5e-6)],
]);

describe("lookupRates", () => {
  test("exact catalog slug matches directly", () => {
    assert.equal(lookupRates(index, "anthropic/claude-sonnet-5"), anthropic);
    assert.equal(lookupRates(index, "some-reseller/claude-sonnet-5"), reseller);
  });

  test("bare subscription id matches, preferring the vendor over resellers", () => {
    assert.equal(lookupRates(index, "claude-sonnet-5"), anthropic);
  });

  test("gateway-prefixed id strips prefixes until the slug matches", () => {
    assert.equal(lookupRates(index, "corp-gw/anthropic/claude-sonnet-5"), anthropic);
    assert.equal(lookupRates(index, "corp-gw/proxy/anthropic/claude-sonnet-5"), anthropic);
  });

  test("unknown gateway prefix still resolves by model name via the vendor", () => {
    assert.equal(lookupRates(index, "megacorp-llm/claude-sonnet-5"), anthropic);
  });

  test("dots and dashes are interchangeable", () => {
    assert.equal(lookupRates(index, "gpt-5.2"), openai);
    assert.equal(lookupRates(index, "gpt-5-2"), openai);
  });

  test("date-suffixed ids fall back to the dateless slug", () => {
    assert.equal(lookupRates(index, "claude-haiku-4-5-20251001"), lookupRates(index, "claude-haiku-4.5"));
    assert.notEqual(lookupRates(index, "claude-haiku-4-5-20251001"), null);
  });

  test("-latest aliases resolve to the base model", () => {
    assert.equal(lookupRates(index, "claude-sonnet-5-latest"), anthropic);
  });

  test("unknown models return null", () => {
    assert.equal(lookupRates(index, "totally-unknown-model"), null);
    assert.equal(lookupRates(index, ""), null);
  });

  test("author segment in the local id outranks the known-vendor bonus", () => {
    // If the user's gateway id names the reseller explicitly, honor it.
    assert.equal(lookupRates(index, "gw/some-reseller/claude-sonnet-5"), reseller);
  });
});
