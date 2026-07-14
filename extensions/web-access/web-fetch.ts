/**
 * Provider-agnostic web_fetch for the web-access extension.
 *
 * Two backends speak different dialects of the same idea:
 *   - Anthropic Messages API: server tool `web_fetch_20250910` (default) or
 *     `web_fetch_20260209` (opt-in, dynamic filtering). Flat tool params; the
 *     raw fetched page comes back to the API caller as a
 *     `web_fetch_tool_result` content block, errors as a typed `error_code`.
 *   - OpenRouter chat/completions: tool `openrouter:web_fetch` with params
 *     nested under `parameters`. The structured fetch result
 *     ({url,title,content,status,retrieved_at}) is only delivered to the
 *     *model*; the API caller receives the model's synthesized text in
 *     `choices[0].message.content`. Raw-content access therefore degrades on
 *     OpenRouter — see parseResult below and README.md.
 *
 * A neutral WebFetchConfig maps onto both request shapes (toToolSpec) and a
 * normalized FetchResult is extracted from both response shapes (parseResult).
 *
 * Engine pinning: the OpenRouter adapter defaults `engine` to "openrouter"
 * and the config loader rejects "auto"/"native". `auto`/`native` resolution is
 * non-deterministic and the `native` engine ignores `max_content_tokens`
 * entirely, so pinning is what makes truncation and domain filtering actually
 * honored and consistent with Anthropic. "openrouter" and "exa" both support
 * token truncation and domain filtering.
 */

export type FetchErrorCode =
  // Anthropic's typed enum, passed through verbatim.
  | "invalid_input"
  | "url_too_long"
  | "url_not_allowed"
  | "url_not_accessible"
  | "too_many_requests"
  | "unsupported_content_type"
  | "max_uses_exceeded"
  | "unavailable"
  // Catch-all for free-text failures we can't classify (OpenRouter).
  | "fetch_failed";

/** Engines that honor both max_content_tokens and domain filters. */
export const OPENROUTER_FETCH_ENGINES = ["openrouter", "exa"] as const;
export type OpenRouterFetchEngine = (typeof OPENROUTER_FETCH_ENGINES)[number];

/**
 * The resolved params handed to an adapter: the neutral core plus the *active*
 * provider's passthroughs. In web-access.json the passthroughs are keyed by
 * provider under `fetch.providerParams`; the config loader merges in only the
 * configured provider's block, so an adapter never sees another provider's
 * params (see config.ts).
 */
export interface WebFetchConfig {
  /** Max fetches per request. Maps to `max_uses` on both providers. */
  maxUses?: number;
  /** Approximate cap on fetched-content tokens. Maps to `max_content_tokens` on both. */
  maxContentTokens?: number;
  /** Only fetch from these domains. Maps to `allowed_domains` on both. */
  allowedDomains?: string[];
  /** Never fetch from these domains. Maps to `blocked_domains` on both. */
  blockedDomains?: string[];
  /** Anthropic passthrough: emit `citations: {enabled}`. */
  citations?: boolean;
  /** Anthropic passthrough: opt into `web_fetch_20260209` (dynamic filtering). */
  dynamicFiltering?: boolean;
  /** OpenRouter passthrough: fetch engine. Pinned to "openrouter" when unset; never "auto". */
  engine?: OpenRouterFetchEngine;
}

export interface FetchResult {
  url: string;
  title?: string;
  /** PDF is deliberately unsupported; base64/application/pdf maps to an error. */
  content: { kind: "text"; data: string; mediaType: string };
  retrievedAt?: string;
  error?: { code: FetchErrorCode; message?: string };
  /** Anthropic only (char_location blocks). Absent on OpenRouter. */
  citations?: unknown[];
}

export interface WebFetchAdapter {
  /** Map the neutral config to the provider's server-tool spec. */
  toToolSpec(config: WebFetchConfig): Record<string, unknown>;
  /** Build the full request body for one fetch of `url`. */
  buildBody(
    model: string,
    url: string,
    prompt: string | undefined,
    config: WebFetchConfig,
  ): Record<string, unknown>;
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  /**
   * Normalize the provider response. Fetch-level failures come back as
   * `result.error`; only transport/protocol-level problems throw.
   */
  parseResult(raw: unknown, ctx: { url: string }): FetchResult;
}

const EMPTY_TEXT = { kind: "text", mediaType: "text/plain", data: "" } as const;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Both providers use the same snake_case keys for domain filters. */
function setDomainFilters(target: Record<string, unknown>, config: WebFetchConfig) {
  if (config.allowedDomains?.length) target.allowed_domains = config.allowedDomains;
  if (config.blockedDomains?.length) target.blocked_domains = config.blockedDomains;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_input",
  "url_too_long",
  "url_not_allowed",
  "url_not_accessible",
  "too_many_requests",
  "unsupported_content_type",
  "max_uses_exceeded",
  "unavailable",
]);

function anthropicToolSpec(config: WebFetchConfig): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    type: config.dynamicFiltering ? "web_fetch_20260209" : "web_fetch_20250910",
    name: "web_fetch", // required, fixed by the API
  };
  if (config.maxUses !== undefined) spec.max_uses = config.maxUses;
  setDomainFilters(spec, config);
  if (config.maxContentTokens !== undefined) spec.max_content_tokens = config.maxContentTokens;
  if (config.citations !== undefined) spec.citations = { enabled: config.citations };
  return spec;
}

const anthropicAdapter: WebFetchAdapter = {
  toToolSpec: anthropicToolSpec,

  buildBody(model, url, prompt, config) {
    // Anthropic only fetches URLs already present in the conversation context,
    // so the URL must appear verbatim in the user message.
    const text = prompt
      ? `${prompt}\n\nFetch this URL: ${url}`
      : `Fetch this URL and briefly state what it contains: ${url}`;
    return {
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: text }],
      tools: [anthropicToolSpec(config)],
    };
  },

  endpoint(baseUrl) {
    const base = baseUrl.replace(/\/$/, "");
    // baseUrl may or may not include /v1 (some gateways omit it for
    // Anthropic-shaped providers; a standard Anthropic setup may include it).
    // Always produce /v1/messages, but don't double-add the prefix.
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  },

  headers(apiKey) {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  },

  parseResult(raw, ctx) {
    const root = isRecord(raw) ? raw : undefined;
    if (root?.type === "error") {
      const err = root.error as { message?: string } | undefined;
      throw new Error(`provider error: ${err?.message ?? JSON.stringify(root.error)}`);
    }

    const content = Array.isArray(root?.content)
      ? (root.content as Record<string, unknown>[])
      : [];

    // Error blocks carry no URL; recover it from the paired server_tool_use input.
    const fetchInputs = new Map<string, string>();
    for (const block of content) {
      if (block?.type !== "server_tool_use" || block.name !== "web_fetch") continue;
      const id = str(block.id);
      const inputUrl = isRecord(block.input) ? str(block.input.url) : undefined;
      if (id && inputUrl) fetchInputs.set(id, inputUrl);
    }

    const resultBlock = content.find((b) => b?.type === "web_fetch_tool_result");
    if (!resultBlock) throw new Error("no web_fetch_tool_result block in response");
    const inner = isRecord(resultBlock.content) ? resultBlock.content : undefined;
    const toolUseId = str(resultBlock.tool_use_id);
    const url =
      str(inner?.url) ?? (toolUseId ? fetchInputs.get(toolUseId) : undefined) ?? ctx.url;

    if (inner?.type === "web_fetch_tool_error") {
      const codeRaw = str(inner.error_code) ?? "unavailable";
      const code = (
        ANTHROPIC_ERROR_CODES.has(codeRaw) ? codeRaw : "fetch_failed"
      ) as FetchErrorCode;
      return { url, content: { ...EMPTY_TEXT }, error: { code } };
    }

    const doc = isRecord(inner?.content) ? inner.content : undefined;
    const source = isRecord(doc?.source) ? doc.source : undefined;
    const mediaType = str(source?.media_type) ?? "text/plain";
    const retrievedAt = str(inner?.retrieved_at);

    // PDFs arrive base64-encoded; we deliberately don't support them.
    if (source?.type === "base64" || mediaType === "application/pdf") {
      return {
        url,
        retrievedAt,
        content: { ...EMPTY_TEXT },
        error: { code: "unsupported_content_type", message: "PDF content is not supported" },
      };
    }

    // Citations (when enabled) are char_location entries on later text blocks.
    const citations: unknown[] = [];
    for (const block of content) {
      if (block?.type === "text" && Array.isArray(block.citations)) {
        citations.push(...block.citations);
      }
    }

    return {
      url,
      title: str(doc?.title),
      content: { kind: "text", data: str(source?.data) ?? "", mediaType },
      retrievedAt,
      ...(citations.length ? { citations } : {}),
    };
  },
};

// ── OpenRouter ───────────────────────────────────────────────────────────────

function openrouterToolSpec(config: WebFetchConfig): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    // Pinned default — never "auto" (non-deterministic; `native` ignores
    // max_content_tokens, which would break parity with Anthropic).
    engine: config.engine ?? "openrouter",
  };
  if (config.maxUses !== undefined) parameters.max_uses = config.maxUses;
  if (config.maxContentTokens !== undefined) parameters.max_content_tokens = config.maxContentTokens;
  setDomainFilters(parameters, config);
  return { type: "openrouter:web_fetch", parameters };
}

/** Map OpenRouter's free-text failure message onto the common error codes. */
export function mapOpenRouterFetchError(message: string): {
  code: FetchErrorCode;
  message: string;
} {
  const m = message.toLowerCase();
  let code: FetchErrorCode = "fetch_failed";
  if (/max(imum)?[ _]?(uses|fetches)|fetch limit/.test(m)) code = "max_uses_exceeded";
  else if (/domain|blocked|not allowed/.test(m)) code = "url_not_allowed";
  else if (/invalid url|malformed/.test(m)) code = "invalid_input";
  else if (/rate limit|too many requests|429/.test(m)) code = "too_many_requests";
  else if (/unsupported (content|type)/.test(m)) code = "unsupported_content_type";
  else if (/http [45]\d\d|not found|timed? ?out|unreachable|failed to fetch/.test(m)) {
    code = "url_not_accessible";
  }
  return { code, message };
}

const openrouterAdapter: WebFetchAdapter = {
  toToolSpec: openrouterToolSpec,

  buildBody(model, url, prompt, config) {
    // The caller never sees the raw fetch result, only the model's text — so
    // the default prompt asks the model to reproduce the content.
    const text = prompt
      ? `${prompt}\n\nFetch this URL: ${url}`
      : `Fetch this URL and reproduce its content faithfully in markdown: ${url}`;
    return {
      model,
      messages: [{ role: "user", content: text }],
      tools: [openrouterToolSpec(config)],
    };
  },

  endpoint(baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  },

  headers(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },

  parseResult(raw, ctx) {
    const root = isRecord(raw) ? raw : undefined;

    // Optional path: the flat structured result ({url,status,...}) is what the
    // *model* receives; OpenRouter does not currently surface it to the API
    // caller, but accept it for full fidelity if a future API (or a caller
    // that extracts it from a tool message) hands it to us. Checked before the
    // API-error envelope because failed fetches also carry an `error` field.
    if (root && str(root.url) && str(root.status)) {
      const url = root.url as string;
      if (root.status === "failed") {
        const msg = str(root.error) ?? "fetch failed";
        return { url, content: { ...EMPTY_TEXT }, error: mapOpenRouterFetchError(msg) };
      }
      return {
        url,
        title: str(root.title),
        content: { kind: "text", data: str(root.content) ?? "", mediaType: "text/plain" },
        retrievedAt: str(root.retrieved_at),
      };
    }

    if (root?.error) {
      const err = root.error as { message?: string };
      const msg =
        typeof root.error === "string" ? root.error : err.message ?? JSON.stringify(root.error);
      throw new Error(`provider error: ${msg}`);
    }

    // Documented (degraded) path: only the model's synthesized text reaches
    // the caller. No raw content, retrieved_at, or citations are available.
    const choices = Array.isArray(root?.choices)
      ? (root.choices as Record<string, unknown>[])
      : [];
    const message = isRecord(choices[0]?.message) ? choices[0].message : undefined;
    if (!message) throw new Error("no choices[0].message in response");

    // Annotations are optional; pick a title from a url_citation matching our URL.
    let title: string | undefined;
    const annotations = Array.isArray(message.annotations)
      ? (message.annotations as Record<string, unknown>[])
      : [];
    for (const a of annotations) {
      const uc = isRecord(a?.url_citation) ? a.url_citation : a;
      if (isRecord(uc) && str(uc.url) === ctx.url && str(uc.title)) {
        title = uc.title as string;
        break;
      }
    }

    return {
      url: ctx.url,
      title,
      content: { kind: "text", data: str(message.content) ?? "", mediaType: "text/markdown" },
    };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

const FETCH_ADAPTERS: Record<string, WebFetchAdapter> = {
  anthropic: anthropicAdapter,
  openrouter: openrouterAdapter,
};

/** Resolve a named adapter, or use the generic Anthropic adapter for custom gateways. */
export function getFetchAdapter(provider: string): WebFetchAdapter {
  return FETCH_ADAPTERS[provider] ?? anthropicAdapter;
}
