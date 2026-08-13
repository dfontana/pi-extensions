import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import extension from "./index.ts";
import { loadConfig } from "./config.ts";
import { extractChatGptAccountId, getAdapter, parseResponse, readSseResponse } from "./providers.ts";

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
    mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(cwd, CONFIG_DIR_NAME, "web-access.json"), JSON.stringify(local));
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
        getAdapter("acme-gateway").buildBody("m", { query: "q", maxResults: 1 }, {}),
        getAdapter("openai").buildBody("m", { query: "q", maxResults: 1 }, {}),
      );
    });

    it("targets the openai-codex OAuth backend with its SSE-only request contract", () => {
      const adapter = getAdapter("openai-codex");

      assert.deepEqual(
        adapter.buildBody(
          "gpt-5.5",
          { query: "bitcoin price", maxResults: 5, searchContextSize: "high", allowedDomains: ["openai.com"] },
          {},
        ),
        {
          model: "gpt-5.5",
          store: false,
          stream: true,
          instructions:
            "You are a web search assistant. Use the web_search tool to answer the user's query, then give a concise answer citing your sources.",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "bitcoin price" }] }],
          tools: [{ type: "web_search", search_context_size: "high", filters: { allowed_domains: ["openai.com"] } }],
          tool_choice: "auto",
        },
      );

      // The codex path lives under /codex/responses, unlike plain providers.
      assert.equal(adapter.stream, true);
      assert.equal(
        adapter.endpoint("https://chatgpt.com/backend-api"),
        "https://chatgpt.com/backend-api/codex/responses",
      );
      assert.equal(getAdapter("openai").endpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/responses");

      // The account id is routed from a claim inside the OAuth JWT itself.
      const payload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }),
      ).toString("base64url");
      const token = `x.${payload}.y`;
      const headers = adapter.headers(token);
      assert.equal(headers["chatgpt-account-id"], "acct-123");
      assert.equal(headers.Authorization, `Bearer ${token}`);
      assert.equal(headers["OpenAI-Beta"], "responses=experimental");
      assert.equal(headers.accept, "text/event-stream");

      assert.throws(() => extractChatGptAccountId("sk-plain-api-key"), /not a ChatGPT OAuth token/);
    });

    it("reassembles the final response from an SSE stream whose completed event has empty output", async () => {
      const message = {
        type: "message",
        content: [{ type: "output_text", text: "Bitcoin is up.", annotations: [{ url: "https://example.com" }] }],
      };
      const events = [
        `data: {"type":"response.created"}\n\n`,
        `data: {"type":"response.output_item.done","item":{"type":"web_search_call"}}\n\n`,
        // Split one event across chunks to exercise buffering.
        `data: {"type":"response.output_item.done","item":${JSON.stringify(message).slice(0, 40)}`,
        `${JSON.stringify(message).slice(40)}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n`,
      ];
      const body = (async function* () {
        for (const e of events) yield new TextEncoder().encode(e);
      })();

      const response = await readSseResponse(body);
      assert.deepEqual(parseResponse(response), {
        text: "Bitcoin is up.",
        annotations: [{ url: "https://example.com" }],
      });

      for (const [failure, pattern] of [
        [`data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n`, /provider error: quota/],
        [`data: {"type":"response.created"}\n\n`, /without response\.completed/],
      ] as const) {
        const stream = (async function* () {
          yield new TextEncoder().encode(failure);
        })();
        await assert.rejects(readSseResponse(stream), pattern);
      }
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

  it("passes each tool signal to refresh while keeping session-start refresh signal-free", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-signal-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "wa-signal-cwd-"));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({
        search: { provider: "openai", model: "gpt-5.5" },
        fetch: { provider: "anthropic", model: "claude-opus-4-8" },
      }),
    );

    try {
      let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
      const refreshOptions: Array<{ signal?: AbortSignal } | undefined> = [];
      const models = new Map([
        ["openai/gpt-5.5", { provider: "openai", id: "gpt-5.5" }],
        ["anthropic/claude-opus-4-8", { provider: "anthropic", id: "claude-opus-4-8" }],
      ]);
      const modelRegistry = {
        refresh: async (options?: { signal?: AbortSignal }) => {
          refreshOptions.push(options);
          return { aborted: false, errors: new Map() };
        },
        find: (provider: string, model: string) => models.get(`${provider}/${model}`),
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: "credentials unavailable" }),
      };
      const notify = () => {};

      extension({
        on: (_event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          sessionStart = handler;
        },
        registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
          tools.set(tool.name, tool);
        },
      } as any);
      assert.ok(sessionStart);

      const sessionSignal = new AbortController().signal;
      const ctx = { cwd, signal: sessionSignal, modelRegistry, ui: { notify } };
      await sessionStart({}, ctx);
      assert.equal(refreshOptions.length, 1);
      assert.equal(refreshOptions[0], undefined);
      assert.equal(tools.size, 2);

      const searchSignal = new AbortController().signal;
      await assert.rejects(
        tools.get("web_search")!.execute("search-call", { query: "test" }, searchSignal, undefined, ctx),
        /auth failed for openai \(credentials unavailable\)/,
      );
      assert.equal(refreshOptions[1]?.signal, searchSignal);

      const fetchSignal = new AbortController().signal;
      await assert.rejects(
        tools.get("web_fetch")!.execute("fetch-call", { url: "https://example.test" }, fetchSignal, undefined, ctx),
        /auth failed for anthropic \(credentials unavailable\)/,
      );
      assert.equal(refreshOptions[2]?.signal, fetchSignal);
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });

  it("stops before resolving credentials when a tool refresh is aborted", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "wa-abort-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "wa-abort-cwd-"));
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "web-access.json"),
      JSON.stringify({ search: { provider: "openai", model: "gpt-5.5" } }),
    );

    try {
      let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
      let abortNextRefresh = false;
      let authCalls = 0;
      const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
      const modelRegistry = {
        refresh: async () => {
          if (abortNextRefresh) return { aborted: true, errors: new Map() };
          return { aborted: false, errors: new Map() };
        },
        find: () => ({ provider: "openai", id: "gpt-5.5" }),
        getApiKeyAndHeaders: async () => {
          authCalls += 1;
          return { ok: true as const, apiKey: "test-key", baseUrl: "https://example.test" };
        },
      };

      extension({
        on: (_event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
          sessionStart = handler;
        },
        registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
          tools.set(tool.name, tool);
        },
      } as any);
      assert.ok(sessionStart);
      const ctx = { cwd, modelRegistry, ui: { notify: () => {} } };
      await sessionStart({}, ctx);
      assert.ok(tools.has("web_search"));

      abortNextRefresh = true;
      await assert.rejects(
        tools.get("web_search")!.execute(
          "search-call",
          { query: "test" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
        /Model refresh was aborted/,
      );
      assert.equal(authCalls, 0);
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
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
          name: "custom OpenAI-compatible search gateway",
          raw: { search: { provider: "acme-gateway", model: "gpt-5.5", providerParams: { "acme-gateway": { user: "pi" } } } },
          expected: {
            search: { provider: "acme-gateway", model: "gpt-5.5", params: {}, providerParams: { user: "pi" } },
            fetch: undefined,
          },
        },
        {
          name: "search only",
          raw: { search: { provider: "openrouter", model: "openai/gpt-5.5", providerParams: { openai: { ignored: true }, openrouter: { engine: "exa" } } } },
          expected: {
            search: { provider: "openrouter", model: "openai/gpt-5.5", params: {}, providerParams: { engine: "exa" } },
            fetch: undefined,
          },
        },
        {
          name: "custom Anthropic-compatible fetch gateway",
          raw: { fetch: { provider: "acme-anthropic", model: "acme-claude" } },
          expected: {
            search: undefined,
            fetch: { provider: "acme-anthropic", model: "acme-claude", params: { maxUses: 5, maxContentTokens: 100_000 } },
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
        [{ fetch: { provider: "openai-codex", model: "m" } }, /fetch\.provider "openai-codex" is not supported — the ChatGPT\/Codex OAuth backend has no web-fetch capability/],
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
