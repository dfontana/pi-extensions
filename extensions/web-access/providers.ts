/**
 * Provider adapters + unified response parser for the web-access extension.
 *
 * Every supported provider speaks the OpenAI Responses API ("/responses") and
 * returns the OpenAI response shape, so a single `parseResponse` handles every
 * response. They differ in how the web-search tool is named, where its
 * parameters live on the request body, and (for openai-codex) the endpoint,
 * auth headers, and transport:
 *
 *   - openai / openrouter: plain JSON POST to `{baseUrl}/responses` with a
 *     Bearer API key.
 *   - openai-codex: the ChatGPT OAuth backend at
 *     `{baseUrl}/codex/responses`. It only accepts requests that look like a
 *     codex client (chatgpt-account-id from the OAuth JWT, originator,
 *     User-Agent, OpenAI-Beta) and only replies over SSE (`stream: true`,
 *     `store: false` are mandatory). Its `response.completed` event carries an
 *     empty `output` array, so the final message must be assembled from
 *     `response.output_item.done` events — see `readSseResponse`.
 */

import os from "node:os";

export interface SearchArgs {
  query: string;
  /** Agent-requested result cap (1–10). Only some providers expose a knob for this. */
  maxResults: number;
  /** Optional agent override of search depth. Wins over the config value. */
  searchContextSize?: string;
  /** Optional per-call domain allow-list. Preferred over `site:` query operators. */
  allowedDomains?: string[];
}

export interface ProviderAdapter {
  /** Build the JSON request body for the Responses API. */
  buildBody(
    model: string,
    args: SearchArgs,
    providerParams: Record<string, unknown>,
  ): Record<string, unknown>;
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  /** SSE-only backend: read the response via `readSseResponse`, not `res.json()`. */
  stream?: boolean;
}

// OpenAI-style `web_search` tool object: params sit flat on the tool. There is
// no result-count knob, so `maxResults` influences nothing here;
// `search_context_size` is the closest depth control.
function buildOpenAISearchTool(
  args: SearchArgs,
  providerParams: Record<string, unknown>,
): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "web_search", ...providerParams };
  if (args.searchContextSize) tool.search_context_size = args.searchContextSize;
  if (args.allowedDomains?.length) {
    const filters = (tool.filters as Record<string, unknown> | undefined) ?? {};
    tool.filters = { ...filters, allowed_domains: args.allowedDomains };
  }
  return tool;
}

const openaiAdapter: ProviderAdapter = {
  buildBody(model, args, providerParams) {
    return { model, input: args.query, tools: [buildOpenAISearchTool(args, providerParams)] };
  },
  endpoint(baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/responses`;
  },
  headers(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },
};

// OpenRouter: params are nested under `parameters` and the tool type differs.
// The agent's explicit `max_results`/`search_context_size` win over config.
const openrouterAdapter: ProviderAdapter = {
  buildBody(model, args, providerParams) {
    const parameters: Record<string, unknown> = {
      ...providerParams,
      max_results: args.maxResults,
    };
    if (args.searchContextSize) parameters.search_context_size = args.searchContextSize;
    if (args.allowedDomains?.length) parameters.allowed_domains = args.allowedDomains;
    return { model, input: args.query, tools: [{ type: "openrouter:web_search", parameters }] };
  },
  endpoint(baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/responses`;
  },
  headers(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },
};

// ── OpenAI Codex (ChatGPT OAuth backend) ─────────────────────────────────────

const CODEX_SEARCH_INSTRUCTIONS =
  "You are a web search assistant. Use the web_search tool to answer the user's query, " +
  "then give a concise answer citing your sources.";

/**
 * The codex backend routes by ChatGPT account, taken from a claim inside the
 * OAuth access token itself (same as pi-ai's transport). The registry hands us
 * that token as the model's "API key".
 */
export function extractChatGptAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      { chatgpt_account_id?: string } | undefined
    >;
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error("no chatgpt_account_id claim");
    return accountId;
  } catch (err) {
    throw new Error(
      `openai-codex credential is not a ChatGPT OAuth token (${err instanceof Error ? err.message : String(err)}) — log in with /login`,
    );
  }
}

const openaiCodexAdapter: ProviderAdapter = {
  stream: true,
  buildBody(model, args, providerParams) {
    return {
      model,
      // The backend requires stream:true (SSE-only) and rejects stored responses.
      store: false,
      stream: true,
      instructions: CODEX_SEARCH_INSTRUCTIONS,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: args.query }],
        },
      ],
      tools: [buildOpenAISearchTool(args, providerParams)],
      tool_choice: "auto",
    };
  },
  endpoint(baseUrl) {
    const base = baseUrl.replace(/\/+$/, "");
    return base.endsWith("/codex") ? `${base}/responses` : `${base}/codex/responses`;
  },
  headers(apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": extractChatGptAccountId(apiKey),
      // Identify as a legitimate codex client; requests without originator/UA
      // are bounced by Cloudflare before reaching the API.
      originator: "pi",
      "User-Agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
    };
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
  "openai-codex": openaiCodexAdapter,
};

/** Resolve a named adapter, or use the generic OpenAI adapter for custom gateways. */
export function getAdapter(provider: string): ProviderAdapter {
  return ADAPTERS[provider] ?? openaiAdapter;
}

// ── SSE transport ────────────────────────────────────────────────────────────

/** Yield the JSON payload of each SSE `data:` event as it completes. */
async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore non-JSON keepalives.
      }
    }
  }
}

/**
 * Consume a Responses-API SSE stream and reconstruct the final response object
 * for `parseResponse`. Output items are collected from
 * `response.output_item.done` because the codex backend's `response.completed`
 * event carries `output: []`; when a backend does populate it, that wins.
 */
export async function readSseResponse(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const output: unknown[] = [];
  let completed: Record<string, unknown> | undefined;

  for await (const event of sseEvents(body)) {
    const e = event as Record<string, unknown>;
    switch (e?.type) {
      case "response.output_item.done":
        output.push(e.item);
        break;
      case "response.completed":
        completed = (e.response ?? {}) as Record<string, unknown>;
        break;
      case "response.failed": {
        const response = e.response as { error?: { message?: string } } | undefined;
        throw new Error(`provider error: ${response?.error?.message ?? "response failed"}`);
      }
      case "error": {
        const message = (e as { message?: string }).message;
        throw new Error(`provider error: ${message ?? JSON.stringify(e)}`);
      }
    }
  }

  if (!completed) throw new Error("SSE stream ended without response.completed");
  const completedOutput = Array.isArray(completed.output) ? completed.output : [];
  return { ...completed, output: completedOutput.length ? completedOutput : output };
}

export interface ParsedResult {
  text: string;
  annotations: unknown[];
}

/**
 * Parse the OpenAI-shaped Responses payload: locate the `type: "message"` item
 * and return its first content block's text + annotations.
 */
export function parseResponse(json: unknown): ParsedResult {
  const root = json as Record<string, unknown> | null;
  if (root && root.error) {
    const err = root.error as { message?: string };
    const msg = typeof root.error === "string" ? root.error : err.message ?? JSON.stringify(root.error);
    throw new Error(`provider error: ${msg}`);
  }

  const output = Array.isArray(root?.output) ? (root!.output as Record<string, unknown>[]) : [];
  const message = output.find((o) => o?.type === "message");
  if (!message) throw new Error("no message item in responses output");

  const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
  const first = content[0];
  if (!first || typeof first.text !== "string") {
    throw new Error("message content[0] missing text");
  }

  return {
    text: first.text,
    annotations: Array.isArray(first.annotations) ? first.annotations : [],
  };
}
