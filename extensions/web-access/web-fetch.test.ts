import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFetchAdapter, type WebFetchConfig } from "./web-fetch.ts";

const anthropic = getFetchAdapter("anthropic");
const openrouter = getFetchAdapter("openrouter");
const URL = "https://example.com/article";

function anthropicSuccess(overrides?: { source?: Record<string, unknown>; citations?: unknown[] }) {
  return {
    content: [
      { type: "server_tool_use", id: "fetch-1", name: "web_fetch", input: { url: URL } },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "fetch-1",
        content: {
          type: "web_fetch_result",
          url: URL,
          content: {
            type: "document",
            source: overrides?.source ?? { type: "text", media_type: "text/plain", data: "Full article text" },
            title: "Article Title",
          },
          retrieved_at: "2025-08-25T10:30:00Z",
        },
      },
      ...(overrides?.citations ? [{ type: "text", citations: overrides.citations }] : []),
    ],
  };
}

function anthropicFailure(code: string) {
  return {
    content: [
      { type: "server_tool_use", id: "fetch-1", name: "web_fetch", input: { url: "https://blocked.example.com" } },
      { type: "web_fetch_tool_result", tool_use_id: "fetch-1", content: { type: "web_fetch_tool_error", error_code: code } },
    ],
  };
}

describe("web-access web-fetch", () => {
  describe("provider request boundary", () => {
    it("maps one fetch policy onto each provider's request format", () => {
      const policy: WebFetchConfig = {
        maxUses: 5,
        maxContentTokens: 100_000,
        allowedDomains: ["example.com"],
        blockedDomains: ["private.example.com"],
        citations: true,
        engine: "exa",
      };

      assert.deepEqual(anthropic.toToolSpec(policy), {
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: 5,
        max_content_tokens: 100_000,
        allowed_domains: ["example.com"],
        blocked_domains: ["private.example.com"],
        citations: { enabled: true },
      });
      assert.deepEqual(openrouter.toToolSpec(policy), {
        type: "openrouter:web_fetch",
        parameters: {
          engine: "exa",
          max_uses: 5,
          max_content_tokens: 100_000,
          allowed_domains: ["example.com"],
          blocked_domains: ["private.example.com"],
        },
      });
      assert.equal(anthropic.toToolSpec({ dynamicFiltering: true }).type, "web_fetch_20260209");
      assert.deepEqual(openrouter.toToolSpec({}), { type: "openrouter:web_fetch", parameters: { engine: "openrouter" } });
      assert.deepEqual(
        getFetchAdapter("acme-anthropic").toToolSpec({ maxUses: 2 }),
        anthropic.toToolSpec({ maxUses: 2 }),
      );
    });

    it("builds requests that give each provider the URL and routes to its API", () => {
      const cases = [
        [anthropic, "claude-opus-4-8", "https://api.anthropic.com/v1/", "https://api.anthropic.com/v1/messages"],
        [openrouter, "openai/gpt-5.5", "https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"],
      ] as const;

      for (const [adapter, model, baseUrl, endpoint] of cases) {
        const body = adapter.buildBody(model, URL, "find the license", { maxUses: 2 }) as {
          model: string;
          messages: Array<{ content: string }>;
          tools: unknown[];
        };
        assert.equal(body.model, model);
        assert.match(body.messages[0].content, /find the license/);
        assert.match(body.messages[0].content, new RegExp(URL));
        assert.equal(body.tools.length, 1);
        assert.equal(adapter.endpoint(baseUrl), endpoint);
      }
    });
  });

  describe("response behavior", () => {
    it("normalizes a successful Anthropic fetch including its optional citations", () => {
      const citations = [{ type: "char_location", cited_text: "article" }];
      const result = anthropic.parseResult(anthropicSuccess({ citations }), { url: "https://fallback.example" });
      assert.deepEqual(result, {
        url: URL,
        title: "Article Title",
        content: { kind: "text", data: "Full article text", mediaType: "text/plain" },
        retrievedAt: "2025-08-25T10:30:00Z",
        citations,
      });
    });

    it("returns portable Anthropic fetch failures instead of provider-shaped errors", () => {
      for (const [providerCode, expectedCode] of [
        ["invalid_input", "invalid_input"],
        ["url_too_long", "url_too_long"],
        ["url_not_allowed", "url_not_allowed"],
        ["url_not_accessible", "url_not_accessible"],
        ["too_many_requests", "too_many_requests"],
        ["unsupported_content_type", "unsupported_content_type"],
        ["max_uses_exceeded", "max_uses_exceeded"],
        ["unavailable", "unavailable"],
        ["future_code", "fetch_failed"],
      ] as const) {
        const result = anthropic.parseResult(anthropicFailure(providerCode), { url: "https://fallback.example" });
        assert.deepEqual(result, {
          url: "https://blocked.example.com",
          content: { kind: "text", data: "", mediaType: "text/plain" },
          error: { code: expectedCode },
        }, providerCode);
      }

      const pdf = anthropic.parseResult(
        anthropicSuccess({ source: { type: "base64", media_type: "application/pdf", data: "JVBERi0" } }),
        { url: URL },
      );
      assert.equal(pdf.error?.code, "unsupported_content_type");
    });

    it("normalizes both documented OpenRouter response forms", () => {
      const synthesized = openrouter.parseResult(
        { choices: [{ message: { content: "The page says hello.", annotations: [{ url_citation: { url: URL, title: "Example Page" } }] } }] },
        { url: URL },
      );
      assert.deepEqual(synthesized, {
        url: URL,
        title: "Example Page",
        content: { kind: "text", data: "The page says hello.", mediaType: "text/markdown" },
      });

      const structured = openrouter.parseResult(
        { url: URL, title: "Article Title", content: "Full article text", status: "completed", retrieved_at: "2025-07-15T14:30:00.000Z" },
        { url: URL },
      );
      assert.deepEqual(structured, {
        url: URL,
        title: "Article Title",
        content: { kind: "text", data: "Full article text", mediaType: "text/plain" },
        retrievedAt: "2025-07-15T14:30:00.000Z",
      });
    });

    it("maps OpenRouter fetch failures onto the common error contract", () => {
      for (const [message, code] of [
        ["HTTP 404: Page not found", "url_not_accessible"],
        ["Domain blocked by filter rules", "url_not_allowed"],
        ["Maximum fetches exceeded", "max_uses_exceeded"],
        ["HTTP 429: Too Many Requests", "too_many_requests"],
        ["something inexplicable", "fetch_failed"],
      ] as const) {
        const result = openrouter.parseResult({ url: URL, status: "failed", error: message }, { url: URL });
        assert.deepEqual(result.error, { code, message }, message);
        assert.equal(result.content.data, "");
      }
    });

    it("throws only for provider or protocol failures", () => {
      for (const [adapter, response, message] of [
        [anthropic, { type: "error", error: { message: "bad key" } }, /provider error: bad key/],
        [anthropic, { content: [{ type: "text", text: "no result" }] }, /no web_fetch_tool_result/],
        [openrouter, { error: { message: "no credits" } }, /provider error: no credits/],
        [openrouter, { choices: [] }, /no choices/],
      ] as const) {
        assert.throws(() => adapter.parseResult(response, { url: URL }), message);
      }
    });
  });
});
