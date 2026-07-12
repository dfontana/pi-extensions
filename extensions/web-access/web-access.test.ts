import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { getAdapter, parseResponse } from "./providers.ts";
import { loadConfig } from "./config.ts";

describe("web-access", () => {

describe("provider adapters buildBody", () => {
  it("openai: flat tool params, agent search_context_size wins over config", () => {
    const body = getAdapter("openai").buildBody(
      "gpt-5.5",
      { query: "bitcoin price", maxResults: 5, searchContextSize: "high" },
      { search_context_size: "low", filters: { allowed_domains: ["x.com"] } },
    );
    assert.deepEqual(body, {
      model: "gpt-5.5",
      input: "bitcoin price",
      tools: [{ type: "web_search", search_context_size: "high", filters: { allowed_domains: ["x.com"] } }],
    });
  });

  it("openrouter: nests params under `parameters`, agent max_results wins", () => {
    const body = getAdapter("openrouter").buildBody(
      "openai/gpt-5.5",
      { query: "ai news", maxResults: 7 },
      { engine: "exa", max_results: 3, max_total_results: 20 },
    );
    assert.deepEqual(body, {
      model: "openai/gpt-5.5",
      input: "ai news",
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { engine: "exa", max_results: 7, max_total_results: 20 },
        },
      ],
    });
  });

  it("openai: allowed_domains merges into filters without clobbering config filters", () => {
    const body = getAdapter("openai").buildBody(
      "gpt-5.5",
      { query: "news", maxResults: 5, allowedDomains: ["openai.com"] },
      { filters: { allowed_domains: ["x.com"], some_other: true } },
    );
    assert.deepEqual(body, {
      model: "gpt-5.5",
      input: "news",
      tools: [
        {
          type: "web_search",
          filters: { allowed_domains: ["openai.com"], some_other: true },
        },
      ],
    });
  });

  it("openrouter: allowed_domains lands flat in parameters", () => {
    const body = getAdapter("openrouter").buildBody(
      "openai/gpt-5.5",
      { query: "news", maxResults: 4, allowedDomains: ["openai.com", "developers.openai.com"] },
      {},
    );
    assert.deepEqual(body, {
      model: "openai/gpt-5.5",
      input: "news",
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { max_results: 4, allowed_domains: ["openai.com", "developers.openai.com"] },
        },
      ],
    });
  });

  it("unknown provider falls back to the openai adapter", () => {
    assert.equal(getAdapter("totally-unknown"), getAdapter("openai"));
  });
});

describe("parseResponse", () => {
  it("extracts text + annotations from the message item (OpenAI shape)", () => {
    const json = {
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Bitcoin is up.",
              annotations: [{ type: "url_citation", url: "https://example.com", title: "X" }],
            },
          ],
        },
      ],
    };
    assert.deepEqual(parseResponse(json), {
      text: "Bitcoin is up.",
      annotations: [{ type: "url_citation", url: "https://example.com", title: "X" }],
    });
  });

  it("defaults annotations to [] when absent", () => {
    const json = { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] };
    assert.deepEqual(parseResponse(json), { text: "hi", annotations: [] });
  });

  it("throws a clear error when the provider returns an error object", () => {
    assert.throws(() => parseResponse({ error: { message: "bad key" } }), /provider error: bad key/);
  });

  it("throws when there is no message item", () => {
    assert.throws(() => parseResponse({ output: [{ type: "web_search_call" }] }), /no message item/);
  });
});

describe("loadConfig merge (local over global)", () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  after(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });

  it("merges tool sections local-over-global, providerParams per provider key", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "wa-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
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
          maxContentTokens: 50000,
          providerParams: { anthropic: { citations: true } },
        },
      }),
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "web-access.json"),
      JSON.stringify({
        search: {
          model: "local-model",
          searchContextSize: "high",
          providerParams: { openai: { filters: { allowed_domains: ["l.com"] } }, openrouter: { engine: "exa" } },
        },
        fetch: { maxUses: 5, allowedDomains: ["example.com"] },
      }),
    );

    const res = loadConfig(cwd);
    assert.ok(res.ok);
    assert.equal(res.config.search?.provider, "openai"); // from global
    assert.equal(res.config.search?.model, "local-model"); // local overrides
    assert.deepEqual(res.config.search?.params, { searchContextSize: "high" }); // local wins
    // active provider's (openai) block, merged across files; openrouter stays dormant
    assert.deepEqual(res.config.search?.providerParams, {
      user_location: { type: "approximate" }, // global preserved
      filters: { allowed_domains: ["l.com"] }, // local added
    });
    assert.deepEqual(res.config.fetch?.params, {
      maxUses: 5, // local overrides
      maxContentTokens: 50000, // global preserved
      allowedDomains: ["example.com"], // local-only key added
      citations: true, // global providerParams.anthropic preserved
    });
  });

  it("fails validation when a section lacks provider or model", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "web-access.json"), JSON.stringify({ search: { provider: "openai" } }));
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /search\.model/);
  });

  it("rejects legacy top-level keys with a pointer to the new shape", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({ provider: "openai", model: "gpt-5.5" }),
    );
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /'provider' is no longer supported/);
  });

  it("per-tool sections: search and fetch can use different providers", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        search: {
          provider: "openai",
          model: "gpt-5.5",
          searchContextSize: "medium",
        },
        fetch: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          maxUses: 3,
          providerParams: { anthropic: { citations: true } },
        },
      }),
    );

    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.ok(res.ok);
    assert.deepEqual(res.config.search, {
      provider: "openai",
      model: "gpt-5.5",
      params: { searchContextSize: "medium" },
      providerParams: {},
    });
    assert.deepEqual(res.config.fetch, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      params: { maxUses: 3, maxContentTokens: 100000, citations: true },
    });
  });

  it("fetch: only the active provider's keyed params are applied", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        fetch: {
          provider: "openrouter",
          model: "openai/gpt-5.5",
          providerParams: {
            anthropic: { citations: true, dynamicFiltering: true },
            openrouter: { engine: "exa" },
          },
        },
      }),
    );

    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.ok(res.ok);
    // engine applied; anthropic's citations/dynamicFiltering stay dormant
    assert.deepEqual(res.config.fetch?.params, {
      maxUses: 5,
      maxContentTokens: 100000,
      engine: "exa",
    });
  });

  it("fetch: defaults make provider/model the only required fields", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({ fetch: { provider: "anthropic", model: "claude-opus-4-8" } }),
    );

    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.ok(res.ok);
    assert.equal(res.config.search, undefined); // omitted section → tool not configured
    assert.deepEqual(res.config.fetch, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      params: { maxUses: 5, maxContentTokens: 100000 },
    });
  });

  it("search: only the active provider's keyed params are applied", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        search: {
          provider: "openrouter",
          model: "openai/gpt-5.5",
          providerParams: {
            openai: { user_location: { type: "approximate" } },
            openrouter: { engine: "exa", max_results: 10 },
          },
        },
      }),
    );

    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.ok(res.ok);
    assert.deepEqual(res.config.search?.providerParams, { engine: "exa", max_results: 10 });
  });

  it("search: rejects an invalid searchContextSize", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({ search: { provider: "openai", model: "m", searchContextSize: "huge" } }),
    );
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /searchContextSize/);
  });

  it("search: defaults make provider/model the only required fields", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({ search: { provider: "openai", model: "gpt-5.5" } }),
    );
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.ok(res.ok);
    assert.deepEqual(res.config.search, {
      provider: "openai",
      model: "gpt-5.5",
      params: {},
      providerParams: {},
    });
    assert.equal(res.config.fetch, undefined);
  });

  it("fetch: rejects engine 'auto' (non-deterministic; breaks truncation parity)", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        fetch: { provider: "openrouter", model: "m", providerParams: { openrouter: { engine: "auto" } } },
      }),
    );
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /providerParams\.openrouter\.engine/);
  });

  it("fails when no tool section is present", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "web-access.json"), JSON.stringify({}));
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /no tool configured/);
  });
});

});
