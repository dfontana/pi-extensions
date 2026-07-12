import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getFetchAdapter,
  mapOpenRouterFetchError,
  type FetchResult,
  type WebFetchConfig,
} from "./web-fetch.ts";

describe("web-access", () => {

const anthropic = getFetchAdapter("anthropic");
const openrouter = getFetchAdapter("openrouter");

const FULL_CONFIG: WebFetchConfig = {
  maxUses: 5,
  maxContentTokens: 100_000,
  allowedDomains: ["example.com", "docs.example.com"],
  blockedDomains: ["private.example.com"],
  citations: true,
  engine: "exa",
};

/** A successful Anthropic Messages response carrying a web_fetch_tool_result. */
function anthropicSuccess(overrides?: { source?: Record<string, unknown> }) {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "I'll fetch the article." },
      {
        type: "server_tool_use",
        id: "srvtoolu_01",
        name: "web_fetch",
        input: { url: "https://example.com/article" },
      },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_01",
        content: {
          type: "web_fetch_result",
          url: "https://example.com/article",
          content: {
            type: "document",
            source: overrides?.source ?? {
              type: "text",
              media_type: "text/plain",
              data: "Full text content of the article...",
            },
            title: "Article Title",
            citations: { enabled: true },
          },
          retrieved_at: "2025-08-25T10:30:00Z",
        },
      },
      {
        type: "text",
        text: "the main argument is...",
        citations: [
          {
            type: "char_location",
            document_index: 0,
            document_title: "Article Title",
            start_char_index: 10,
            end_char_index: 20,
            cited_text: "argument",
          },
        ],
      },
    ],
  };
}

function anthropicError(errorCode: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_err",
        name: "web_fetch",
        input: { url: "https://blocked.example.com/page" },
      },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_err",
        content: { type: "web_fetch_tool_error", error_code: errorCode },
      },
    ],
  };
}

describe("toToolSpec round-trips one WebFetchConfig to both providers", () => {
  it("anthropic: flat fields, default version, citations wrapped, engine ignored", () => {
    assert.deepEqual(anthropic.toToolSpec(FULL_CONFIG), {
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 5,
      allowed_domains: ["example.com", "docs.example.com"],
      blocked_domains: ["private.example.com"],
      max_content_tokens: 100_000,
      citations: { enabled: true },
    });
  });

  it("anthropic: dynamicFiltering opts into web_fetch_20260209", () => {
    const spec = anthropic.toToolSpec({ dynamicFiltering: true });
    assert.equal(spec.type, "web_fetch_20260209");
    assert.equal(spec.name, "web_fetch");
  });

  it("openrouter: params nested under `parameters`, citations ignored", () => {
    assert.deepEqual(openrouter.toToolSpec(FULL_CONFIG), {
      type: "openrouter:web_fetch",
      parameters: {
        engine: "exa",
        max_uses: 5,
        max_content_tokens: 100_000,
        allowed_domains: ["example.com", "docs.example.com"],
        blocked_domains: ["private.example.com"],
      },
    });
  });

  it("openrouter: engine is pinned to 'openrouter' by default, never 'auto'", () => {
    const spec = openrouter.toToolSpec({});
    assert.deepEqual(spec, {
      type: "openrouter:web_fetch",
      parameters: { engine: "openrouter" },
    });
  });

  it("unknown provider falls back to the anthropic adapter (the spec to implement)", () => {
    assert.equal(getFetchAdapter("totally-unknown"), anthropic);
  });

  it("both: maxContentTokens and domain filters land on both providers", () => {
    const cfg: WebFetchConfig = { maxContentTokens: 5000, blockedDomains: ["x.com"] };
    const a = anthropic.toToolSpec(cfg);
    const o = openrouter.toToolSpec(cfg) as { parameters: Record<string, unknown> };
    assert.equal(a.max_content_tokens, 5000);
    assert.deepEqual(a.blocked_domains, ["x.com"]);
    assert.equal(o.parameters.max_content_tokens, 5000);
    assert.deepEqual(o.parameters.blocked_domains, ["x.com"]);
  });
});

describe("buildBody", () => {
  it("anthropic: the URL appears verbatim in the user message (context-URL restriction)", () => {
    const body = anthropic.buildBody("claude-opus-4-8", "https://example.com/a", undefined, {}) as {
      messages: Array<{ role: string; content: string }>;
      tools: unknown[];
    };
    assert.ok(body.messages[0].content.includes("https://example.com/a"));
    assert.equal(body.messages.length, 1);
    assert.equal(body.tools.length, 1);
  });

  it("openrouter: chat/completions shape with the tool attached", () => {
    const body = openrouter.buildBody("openai/gpt-5.5", "https://example.com/a", "find the license", {
      maxUses: 2,
    }) as { model: string; messages: Array<{ content: string }>; tools: Array<Record<string, unknown>> };
    assert.equal(body.model, "openai/gpt-5.5");
    assert.ok(body.messages[0].content.includes("find the license"));
    assert.ok(body.messages[0].content.includes("https://example.com/a"));
    assert.equal(body.tools[0].type, "openrouter:web_fetch");
  });

  it("endpoints: anthropic /messages, openrouter /chat/completions", () => {
    assert.equal(anthropic.endpoint("https://api.anthropic.com/v1/"), "https://api.anthropic.com/v1/messages");
    assert.equal(openrouter.endpoint("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("parseResult: anthropic", () => {
  it("success (text): url, title, content, retrievedAt, citations", () => {
    const result = anthropic.parseResult(anthropicSuccess(), { url: "https://example.com/article" });
    assert.deepEqual(result, {
      url: "https://example.com/article",
      title: "Article Title",
      content: {
        kind: "text",
        data: "Full text content of the article...",
        mediaType: "text/plain",
      },
      retrievedAt: "2025-08-25T10:30:00Z",
      citations: [
        {
          type: "char_location",
          document_index: 0,
          document_title: "Article Title",
          start_char_index: 10,
          end_char_index: 20,
          cited_text: "argument",
        },
      ],
    });
  });

  it("success without citations: citations key absent (graceful degradation)", () => {
    const response = anthropicSuccess();
    response.content = response.content.filter((b) => !("citations" in b));
    const result = anthropic.parseResult(response, { url: "https://example.com/article" });
    assert.ok(!("citations" in result));
  });

  it("each typed error code maps through; url recovered from server_tool_use", () => {
    for (const code of [
      "invalid_input",
      "url_too_long",
      "url_not_allowed",
      "url_not_accessible",
      "too_many_requests",
      "unsupported_content_type",
      "max_uses_exceeded",
      "unavailable",
    ]) {
      const result = anthropic.parseResult(anthropicError(code), { url: "https://fallback.example" });
      assert.deepEqual(result, {
        url: "https://blocked.example.com/page",
        content: { kind: "text", data: "", mediaType: "text/plain" },
        error: { code },
      });
    }
  });

  it("domain-blocked: url_not_allowed", () => {
    const result = anthropic.parseResult(anthropicError("url_not_allowed"), {
      url: "https://blocked.example.com/page",
    });
    assert.equal(result.error?.code, "url_not_allowed");
  });

  it("unknown error code degrades to fetch_failed instead of crashing", () => {
    const result = anthropic.parseResult(anthropicError("brand_new_code"), { url: "https://x" });
    assert.equal(result.error?.code, "fetch_failed");
  });

  it("PDF (base64) is rejected as unsupported_content_type", () => {
    const response = anthropicSuccess({
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK..." },
    });
    const result = anthropic.parseResult(response, { url: "https://example.com/article" });
    assert.equal(result.error?.code, "unsupported_content_type");
    assert.equal(result.content.data, "");
  });

  it("throws on a top-level API error envelope", () => {
    assert.throws(
      () => anthropic.parseResult({ type: "error", error: { message: "bad key" } }, { url: "https://x" }),
      /provider error: bad key/,
    );
  });

  it("throws when no web_fetch_tool_result block exists", () => {
    assert.throws(
      () => anthropic.parseResult({ content: [{ type: "text", text: "hi" }] }, { url: "https://x" }),
      /no web_fetch_tool_result/,
    );
  });
});

describe("parseResult: openrouter", () => {
  it("degraded path (documented): synthesized text from choices[0].message.content", () => {
    const result = openrouter.parseResult(
      { choices: [{ message: { role: "assistant", content: "The page says hello." } }] },
      { url: "https://example.com/a" },
    );
    assert.deepEqual(result, {
      url: "https://example.com/a",
      title: undefined,
      content: { kind: "text", data: "The page says hello.", mediaType: "text/markdown" },
    });
  });

  it("degraded path: optional annotations supply a title when present", () => {
    const result = openrouter.parseResult(
      {
        choices: [
          {
            message: {
              content: "Summary.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/a", title: "Example Page" },
                },
              ],
            },
          },
        ],
      },
      { url: "https://example.com/a" },
    );
    assert.equal(result.title, "Example Page");
  });

  it("structured path (optional): flat completed object normalizes with full fidelity", () => {
    const result = openrouter.parseResult(
      {
        url: "https://example.com/article",
        title: "Article Title",
        content: "The full text content of the page...",
        status: "completed",
        retrieved_at: "2025-07-15T14:30:00.000Z",
      },
      { url: "https://example.com/article" },
    );
    assert.deepEqual(result, {
      url: "https://example.com/article",
      title: "Article Title",
      content: { kind: "text", data: "The full text content of the page...", mediaType: "text/plain" },
      retrievedAt: "2025-07-15T14:30:00.000Z",
    });
  });

  it("structured path: failed status maps free-text errors onto common codes", () => {
    const cases: Array<[string, string]> = [
      ["HTTP 404: Page not found", "url_not_accessible"],
      ["Domain blocked by filter rules", "url_not_allowed"],
      ["Maximum fetches exceeded for this request", "max_uses_exceeded"],
      ["HTTP 429: Too Many Requests", "too_many_requests"],
      ["something inexplicable", "fetch_failed"],
    ];
    for (const [message, code] of cases) {
      const result = openrouter.parseResult(
        { url: "https://example.com/404", status: "failed", error: message },
        { url: "https://example.com/404" },
      );
      assert.deepEqual(result.error, { code, message }, `for "${message}"`);
      assert.equal(result.content.data, "");
    }
  });

  it("throws on a top-level API error", () => {
    assert.throws(
      () => openrouter.parseResult({ error: { message: "no credits" } }, { url: "https://x" }),
      /provider error: no credits/,
    );
  });

  it("throws when there is no message", () => {
    assert.throws(() => openrouter.parseResult({ choices: [] }, { url: "https://x" }), /no choices/);
  });
});

describe("FetchResult shape parity across providers", () => {
  const ALLOWED_KEYS = new Set(["url", "title", "content", "retrievedAt", "error", "citations"]);

  function checkShape(result: FetchResult) {
    for (const key of Object.keys(result)) {
      assert.ok(ALLOWED_KEYS.has(key), `unexpected key ${key}`);
    }
    assert.equal(typeof result.url, "string");
    assert.equal(result.content.kind, "text");
    assert.equal(typeof result.content.data, "string");
    assert.equal(typeof result.content.mediaType, "string");
    if (result.error) assert.equal(typeof result.error.code, "string");
  }

  it("success and error results from both adapters fit the same shape", () => {
    checkShape(anthropic.parseResult(anthropicSuccess(), { url: "https://example.com/article" }));
    checkShape(anthropic.parseResult(anthropicError("url_not_accessible"), { url: "https://x" }));
    checkShape(
      openrouter.parseResult(
        { choices: [{ message: { content: "text" } }] },
        { url: "https://example.com/a" },
      ),
    );
    checkShape(
      openrouter.parseResult(
        { url: "https://x", status: "failed", error: "HTTP 500" },
        { url: "https://x" },
      ),
    );
  });
});

describe("mapOpenRouterFetchError", () => {
  it("preserves the original free-text message", () => {
    const mapped = mapOpenRouterFetchError("HTTP 404: Page not found");
    assert.equal(mapped.message, "HTTP 404: Page not found");
    assert.equal(mapped.code, "url_not_accessible");
  });
});

});
