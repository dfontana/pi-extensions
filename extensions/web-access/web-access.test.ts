import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig } from "./config.ts";
import { getAdapter, parseResponse } from "./providers.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function loadTestConfig(global: unknown, local?: unknown) {
  const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "wa-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "web-access.json"), JSON.stringify(global));
  if (local !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "web-access.json"), JSON.stringify(local));
  }
  return loadConfig(cwd);
}

function configOrFail(global: unknown, local?: unknown) {
  const result = loadTestConfig(global, local);
  if (!result.ok) assert.fail(result.error);
  return result.config;
}

describe("web-access web-access", () => {
  describe("search provider boundary", () => {
    it("builds the provider-specific search request from one common search", () => {
      const cases = [
        {
          provider: "openai",
          model: "gpt-5.5",
          args: { query: "bitcoin price", maxResults: 5, searchContextSize: "high", allowedDomains: ["openai.com"] },
          params: { search_context_size: "low", filters: { some_other: true } },
          expected: {
            model: "gpt-5.5",
            input: "bitcoin price",
            tools: [{ type: "web_search", search_context_size: "high", filters: { some_other: true, allowed_domains: ["openai.com"] } }],
          },
        },
        {
          provider: "openrouter",
          model: "openai/gpt-5.5",
          args: { query: "bitcoin price", maxResults: 5, searchContextSize: "high", allowedDomains: ["openai.com"] },
          params: { engine: "exa", max_results: 3 },
          expected: {
            model: "openai/gpt-5.5",
            input: "bitcoin price",
            tools: [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5, search_context_size: "high", allowed_domains: ["openai.com"] } }],
          },
        },
      ];

      for (const { provider, model, args, params, expected } of cases) {
        assert.deepEqual(getAdapter(provider).buildBody(model, args, params), expected, provider);
      }

      assert.deepEqual(
        getAdapter("future-provider").buildBody("m", { query: "q", maxResults: 1 }, {}),
        getAdapter("openai").buildBody("m", { query: "q", maxResults: 1 }, {}),
      );
    });

    it("normalizes search responses and reports unusable provider responses", () => {
      assert.deepEqual(
        parseResponse({
          output: [{ type: "message", content: [{ text: "Bitcoin is up.", annotations: [{ url: "https://example.com" }] }] }],
        }),
        { text: "Bitcoin is up.", annotations: [{ url: "https://example.com" }] },
      );

      for (const [response, message] of [
        [{ error: { message: "bad key" } }, /provider error: bad key/],
        [{ output: [{ type: "web_search_call" }] }, /no message item/],
        [{ output: [{ type: "message", content: [{}] }] }, /missing text/],
      ] as const) {
        assert.throws(() => parseResponse(response), message);
      }
    });
  });

  describe("configuration behavior", () => {
    it("merges project settings over global settings while retaining only active-provider options", () => {
      const config = configOrFail(
        {
          search: {
            provider: "openai",
            model: "global-model",
            searchContextSize: "low",
            providerParams: { openai: { user_location: { type: "approximate" } } },
          },
          fetch: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            maxUses: 3,
            maxContentTokens: 50_000,
            providerParams: { anthropic: { citations: true } },
          },
        },
        {
          search: {
            model: "local-model",
            searchContextSize: "high",
            providerParams: { openai: { filters: { allowed_domains: ["local.example"] } }, openrouter: { engine: "exa" } },
          },
          fetch: { maxUses: 5, allowedDomains: ["example.com"] },
        },
      );

      assert.deepEqual(config, {
        search: {
          provider: "openai",
          model: "local-model",
          params: { searchContextSize: "high" },
          providerParams: { user_location: { type: "approximate" }, filters: { allowed_domains: ["local.example"] } },
        },
        fetch: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          params: { maxUses: 5, maxContentTokens: 50_000, allowedDomains: ["example.com"], citations: true },
        },
      });
    });

    it("enables either tool independently and supplies fetch defaults", () => {
      const cases = [
        {
          name: "search only",
          raw: { search: { provider: "openrouter", model: "openai/gpt-5.5", providerParams: { openai: { ignored: true }, openrouter: { engine: "exa" } } } },
          expected: {
            search: { provider: "openrouter", model: "openai/gpt-5.5", params: {}, providerParams: { engine: "exa" } },
            fetch: undefined,
          },
        },
        {
          name: "fetch only",
          raw: { fetch: { provider: "anthropic", model: "claude-opus-4-8" } },
          expected: {
            search: undefined,
            fetch: { provider: "anthropic", model: "claude-opus-4-8", params: { maxUses: 5, maxContentTokens: 100_000 } },
          },
        },
      ] as const;

      for (const { name, raw, expected } of cases) {
        assert.deepEqual(configOrFail(raw), expected, name);
      }
    });

    it("rejects invalid or obsolete configuration with actionable errors", () => {
      const cases = [
        [{ search: { provider: "openai" } }, /search\.model/],
        [{ search: { provider: "openai", model: "m", searchContextSize: "huge" } }, /searchContextSize/],
        [{ fetch: { provider: "openrouter", model: "m", providerParams: { openrouter: { engine: "auto" } } } }, /providerParams\.openrouter\.engine/],
        [{ provider: "openai", model: "gpt-5.5" }, /'provider' is no longer supported/],
        [{}, /no tool configured/],
      ] as const;

      for (const [raw, message] of cases) {
        const result = loadTestConfig(raw);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, message);
      }
    });
  });
});
