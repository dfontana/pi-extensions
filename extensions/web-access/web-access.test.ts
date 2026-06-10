import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { getAdapter, parseResponse } from "./providers.ts";
import { loadConfig } from "./config.ts";

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

  it("overrides scalars and deep-merges providerParams per key", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "wa-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        provider: "openai",
        model: "global-model",
        providerParams: { openai: { search_context_size: "low", filters: { allowed_domains: ["g.com"] } } },
      }),
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "web-access.json"),
      JSON.stringify({
        model: "local-model",
        providerParams: { openai: { search_context_size: "high" }, openrouter: { engine: "exa" } },
      }),
    );

    const res = loadConfig(cwd);
    assert.ok(res.ok);
    assert.equal(res.config.provider, "openai"); // from global
    assert.equal(res.config.model, "local-model"); // local overrides
    assert.deepEqual(res.config.providerParams, {
      // openai: local search_context_size wins, global filters preserved
      openai: { search_context_size: "high", filters: { allowed_domains: ["g.com"] } },
      openrouter: { engine: "exa" }, // local-only key added
    });
  });

  it("fails validation when required fields are absent", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "web-access.json"), JSON.stringify({ provider: "openai" }));
    const res = loadConfig(mkdtempSync(join(tmpdir(), "wa-cwd-")));
    assert.equal(res.ok, false);
  });
});
