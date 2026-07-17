/**
 * web-access — gives the agent `web_search` and `web_fetch` tools backed by a
 * configured model provider (`web_search`: OpenAI-style Responses API, incl.
 * the openai-codex ChatGPT OAuth backend; `web_fetch`: Anthropic Messages API
 * or OpenRouter chat/completions).
 *
 * The provider/model and any provider-specific params are read from
 * `web-access.json` (global ~/.pi/agent + project ./.pi override). On session
 * start the config is validated and the chosen model is checked against pi's
 * model registry (including credential resolution). If anything is wrong we warn
 * the user and simply don't register the tool, leaving it disabled.
 *
 * pi exposes no internal API to invoke a provider's endpoints, so the tools
 * issue the HTTP requests themselves via fetch() — but auth (api key + headers)
 * is resolved through pi's model registry, never rolled by hand.
 *
 * See README.md for the web_fetch behavioral contract (Anthropic context-URL
 * restriction, OpenRouter raw-content degradation, PDF/citation asymmetries).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, type FetchToolConfig, type SearchToolConfig } from "./config.ts";
import { getAdapter, parseResponse, readSseResponse } from "./providers.ts";
import { getFetchAdapter, type FetchResult } from "./web-fetch.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Markdown theme reads the active theme lazily through its closures, so a single
// module-level instance stays correct across runtime theme switches.
const MARKDOWN_THEME = getMarkdownTheme();

/**
 * Check that a provider/model exists in the registry. Used at session_start to
 * catch misconfigured provider/model names early without triggering credential
 * resolution (auth headers sourced from env vars — e.g. $PI_CLIENT_SESSION_ID —
 * may not be set yet at session_start time; they are resolved correctly at
 * execute time).
 */
function checkModelExists(
  modelRegistry: ModelRegistry,
  provider: string,
  modelId: string,
): { ok: true } | { ok: false; error: string } {
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    return { ok: false, error: `model ${provider}/${modelId} is not in the model registry` };
  }
  if (!model.baseUrl) {
    return { ok: false, error: `no baseUrl found for ${provider}/${modelId}` };
  }
  return { ok: true };
}

/**
 * Resolve a provider/model and its credentials from the registry. Used by
 * execute (re-resolve fresh each call so a mid-session credential/registry
 * change is picked up).
 */
async function resolveModelAuth(
  modelRegistry: ModelRegistry,
  provider: string,
  modelId: string,
): Promise<
  | { ok: true; model: Model<Api>; apiKey: string; headers?: Record<string, string> }
  | { ok: false; error: string }
> {
  // Since pi 0.80.8 model loading is async and find() reads a snapshot; refresh
  // reloads models.json so a mid-session registry change is actually observed.
  await modelRegistry.refresh();
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    return { ok: false, error: `model ${provider}/${modelId} is not in the model registry` };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, error: `auth failed for ${provider} (${auth.error})` };
  if (!auth.apiKey) return { ok: false, error: `no API key for ${provider}` };
  if (!model.baseUrl) return { ok: false, error: `no baseUrl found for ${provider}/${modelId}` };
  return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
}

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details: undefined };

/**
 * POST a JSON body, animating a spinner through onUpdate while the request is
 * in flight (the partial content re-renders the result row — see the tools'
 * renderResult). Shared by web_search and web_fetch. Throws on non-2xx.
 *
 * With `sse` set the endpoint replies with an event stream instead of a JSON
 * body (openai-codex is SSE-only); the final response object is reassembled
 * from the stream by `readSseResponse`.
 */
async function postJsonWithThrobber(opts: {
  toolName: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  onUpdate: ((update: ToolUpdate) => void) | undefined;
  workingText: string;
  sse?: boolean;
}): Promise<unknown> {
  let frame = 0;
  const throbber = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    opts.onUpdate?.({
      content: [{ type: "text", text: `${SPINNER_FRAMES[frame]} ${opts.workingText}` }],
      details: undefined,
    });
  }, 120);
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`${opts.toolName} request failed (${res.status}): ${await res.text()}`);
    }
    if (opts.sse) {
      if (!res.body) throw new Error(`${opts.toolName}: response has no body`);
      return await readSseResponse(res.body as unknown as AsyncIterable<Uint8Array>);
    }
    return await res.json();
  } finally {
    clearInterval(throbber);
  }
}

function registerWebSearch(pi: ExtensionAPI, cfg: SearchToolConfig) {
  const adapter = getAdapter(cfg.provider);

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current information and return a summarized answer with source citations.",
    promptSnippet: "Search the web for up-to-date information",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      max_results: Type.Integer({
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Maximum number of web results to draw on (1–10).",
      }),
      search_context_size: Type.Optional(
        StringEnum(["low", "medium", "high"] as const, {
          description: "How much web context to retrieve. Larger is slower but more thorough.",
        }),
      ),
      allowed_domains: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Restrict results to these domains (e.g. ["openai.com"]). Prefer this over `site:` operators in the query.',
        }),
      ),
    }),

    // Show the query + params in the tool row instead of a bare "web_search".
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("web_search"));
      if (args?.query) content += " " + theme.fg("muted", `"${args.query}"`);
      const bits: string[] = [];
      if (args?.max_results) bits.push(`${args.max_results} results`);
      if (args?.search_context_size) bits.push(String(args.search_context_size));
      if (args?.allowed_domains?.length) bits.push(`@ ${args.allowed_domains.join(", ")}`);
      if (bits.length) content += " " + theme.fg("dim", `(${bits.join(", ")})`);
      text.setText(content);
      return text;
    },

    // Foldable result: collapsed shows a one-line preview + stats; the built-in
    // expand toggle (ctrl+o) flips `expanded` to reveal the full response. While
    // executing, `execute` streams spinner frames as partial content (isPartial).
    renderResult(result, { expanded, isPartial }, theme, context) {
      const first = result.content?.[0];
      const body = first?.type === "text" ? first.text : "";

      if (isPartial) {
        return new Text(theme.fg("accent", body || "Searching the web…"), 0, 0);
      }

      if (context.isError) {
        return new Text(theme.fg("error", body || "web_search failed"), 0, 0);
      }

      const annotations =
        (result.details as { annotations?: Array<{ url?: string; title?: string }> } | undefined)
          ?.annotations ?? [];

      if (expanded) {
        // Render the markdown answer, then a deduped Sources list from annotations.
        const seen = new Set<string>();
        const sources: string[] = [];
        for (const a of annotations) {
          const url = a?.url;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          sources.push(`${sources.length + 1}. [${a.title ?? url}](${url})`);
        }
        const md = sources.length ? `${body}\n\n**Sources**\n${sources.join("\n")}` : body;
        return new Markdown(md, 1, 0, MARKDOWN_THEME);
      }

      const n = annotations.length;
      const oneLine = body.replace(/\s+/g, " ").trim();
      // Width-aware: truncate the preview to the row width so it never wraps.
      // `width` is supplied by the TUI at render time (Component.render(width)).
      return {
        render(width: number) {
          const preview = theme.fg("muted", truncateToWidth(oneLine, width, "…"));
          const stats = theme.fg("dim", `${body.length} chars · ${n} source${n === 1 ? "" : "s"}`);
          return [preview, truncateToWidth(stats, width)];
        },
        invalidate() {},
      };
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Re-resolve per call so a mid-session credential/registry change is honored.
      const resolved = await resolveModelAuth(ctx.modelRegistry, cfg.provider, cfg.model);
      if (!resolved.ok) throw new Error(resolved.error);
      const { model, apiKey, headers } = resolved;

      // Agent-supplied args win; the config's common params are the defaults.
      const body = adapter.buildBody(
        model.id,
        {
          query: params.query,
          maxResults: params.max_results,
          searchContextSize: params.search_context_size ?? cfg.params.searchContextSize,
          allowedDomains: params.allowed_domains ?? cfg.params.allowedDomains,
        },
        cfg.providerParams,
      );

      const json = await postJsonWithThrobber({
        toolName: "web_search",
        url: adapter.endpoint(model.baseUrl),
        headers: { ...adapter.headers(apiKey), ...headers },
        body,
        signal: signal ?? ctx.signal,
        onUpdate,
        workingText: "Searching the web…",
        sse: adapter.stream,
      });

      const { text, annotations } = parseResponse(json);
      // `content` is what reaches the LLM; `details` is for rendering only. The
      // agent needs the citations, so serialize annotations into a content block.
      const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];
      if (annotations.length > 0) {
        content.push({ type: "text", text: `Sources (annotations):\n${JSON.stringify(annotations, null, 2)}` });
      }
      return { content, details: { annotations } };
    },
  });
}

function registerWebFetch(pi: ExtensionAPI, cfg: FetchToolConfig) {
  const adapter = getFetchAdapter(cfg.provider);

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch the text content of a specific web page by URL. Does not support PDFs or JavaScript-rendered pages.",
    promptSnippet: "Fetch the content of a URL",
    parameters: Type.Object({
      url: Type.String({ description: "The full http(s) URL to fetch." }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Optional: what to extract or answer from the page. Guides content filtering where the provider supports it; defaults to returning the page content.",
        }),
      ),
    }),

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("web_fetch"));
      if (args?.url) content += " " + theme.fg("muted", args.url);
      if (args?.prompt) content += " " + theme.fg("dim", `("${args.prompt}")`);
      text.setText(content);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const first = result.content?.[0];
      const body = first?.type === "text" ? first.text : "";

      if (isPartial) {
        return new Text(theme.fg("accent", body || "Fetching…"), 0, 0);
      }
      if (context.isError) {
        return new Text(theme.fg("error", body || "web_fetch failed"), 0, 0);
      }

      const details = result.details as { result?: FetchResult } | undefined;
      const fetched = details?.result;

      if (expanded) {
        return new Markdown(body, 1, 0, MARKDOWN_THEME);
      }

      const oneLine = body.replace(/\s+/g, " ").trim();
      return {
        render(width: number) {
          const preview = theme.fg("muted", truncateToWidth(oneLine, width, "…"));
          const bits = [`${fetched?.content.data.length ?? body.length} chars`];
          if (fetched?.title) bits.push(fetched.title);
          if (fetched?.retrievedAt) bits.push(fetched.retrievedAt);
          const stats = theme.fg("dim", bits.join(" · "));
          return [preview, truncateToWidth(stats, width)];
        },
        invalidate() {},
      };
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Re-resolve per call so a mid-session credential/registry change is honored.
      const resolved = await resolveModelAuth(ctx.modelRegistry, cfg.provider, cfg.model);
      if (!resolved.ok) throw new Error(resolved.error);
      const { model, apiKey, headers } = resolved;

      const body = adapter.buildBody(model.id, params.url, params.prompt, cfg.params);

      const json = await postJsonWithThrobber({
        toolName: "web_fetch",
        url: adapter.endpoint(model.baseUrl),
        headers: { ...adapter.headers(apiKey), ...headers },
        body,
        signal: signal ?? ctx.signal,
        onUpdate,
        workingText: `Fetching ${params.url}…`,
      });

      const result = adapter.parseResult(json, { url: params.url });
      if (result.error) {
        const detail = result.error.message ? `: ${result.error.message}` : "";
        throw new Error(`web_fetch failed (${result.error.code})${detail}`);
      }

      // `content` is what reaches the LLM; `details` is for rendering only.
      const header = [
        result.title ? `# ${result.title}` : undefined,
        `URL: ${result.url}`,
        result.retrievedAt ? `Retrieved: ${result.retrievedAt}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: `${header}\n\n${result.content.data}` },
      ];
      if (result.citations?.length) {
        content.push({
          type: "text",
          text: `Citations:\n${JSON.stringify(result.citations, null, 2)}`,
        });
      }
      return { content, details: { result } };
    },
  });
}

export default function (pi: ExtensionAPI) {
  // modelRegistry is only available on ExtensionContext, so validation (and the
  // registry/credential checks) must run in session_start, not the bare factory.
  pi.on("session_start", async (_event, ctx) => {
    const result = loadConfig(ctx.cwd);
    if (!result.ok) {
      ctx.ui.notify(`web-access disabled: ${result.error}`, "warning");
      return;
    }
    const { search, fetch } = result.config;

    // Each tool checks that its provider/model exists in the registry and is
    // disabled independently on failure — search and fetch may use different
    // providers, so one being broken must not take the other down.
    //
    // Full credential resolution (API key + headers) is intentionally deferred
    // to execute() time. Some header values (e.g. $PI_CLIENT_SESSION_ID) are
    // sourced from env vars that pi populates after session_start fires, so
    // calling getApiKeyAndHeaders() here would produce a false-negative failure
    // even though the credentials resolve correctly at request time.
    //
    // Since pi 0.80.8 model loading is async; refresh() must be awaited before
    // synchronous registry reads like find(), or the checks below can race the
    // initial model load and produce false "not in the model registry" errors.
    await ctx.modelRegistry.refresh();
    const searchCheck = search && checkModelExists(ctx.modelRegistry, search.provider, search.model);
    const fetchCheck = fetch && checkModelExists(ctx.modelRegistry, fetch.provider, fetch.model);

    if (search && searchCheck) {
      if (searchCheck.ok) {
        registerWebSearch(pi, search);
      } else {
        ctx.ui.notify(`web_search disabled: ${searchCheck.error}`, "warning");
      }
    }

    if (fetch && fetchCheck) {
      if (fetchCheck.ok) {
        registerWebFetch(pi, fetch);
      } else {
        ctx.ui.notify(`web_fetch disabled: ${fetchCheck.error}`, "warning");
      }
    }
  });
}
