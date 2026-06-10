/**
 * Provider adapters + unified response parser for the web-access extension.
 *
 * Every supported provider speaks the OpenAI Responses API ("/responses") and
 * returns the OpenAI response shape. They differ only in how the web-search
 * tool is named and where its parameters live on the request body, so each
 * provider gets a small `buildBody` adapter while a single `parseResponse`
 * handles every response.
 */

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
}

// OpenAI: params sit flat on the tool object. `web_search` has no result-count
// knob, so `maxResults` only influences nothing here; `search_context_size` is
// the closest depth control.
const openaiAdapter: ProviderAdapter = {
  buildBody(model, args, providerParams) {
    const tool: Record<string, unknown> = { type: "web_search", ...providerParams };
    if (args.searchContextSize) tool.search_context_size = args.searchContextSize;
    if (args.allowedDomains?.length) {
      const filters = (tool.filters as Record<string, unknown> | undefined) ?? {};
      tool.filters = { ...filters, allowed_domains: args.allowedDomains };
    }
    return { model, input: args.query, tools: [tool] };
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
};

const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
};

/** Resolve an adapter; unknown providers fall back to the generic OpenAI shape. */
export function getAdapter(provider: string): ProviderAdapter {
  return ADAPTERS[provider] ?? openaiAdapter;
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
