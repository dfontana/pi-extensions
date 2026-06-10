/**
 * web-access — gives the agent a `web_search` tool backed by a configured model
 * provider's OpenAI-style Responses API.
 *
 * The provider/model and any provider-specific web-search params are read from
 * `web-access.json` (global ~/.pi/agent + project ./.pi override). On session
 * start the config is validated and the chosen model is checked against pi's
 * model registry (including credential resolution). If anything is wrong we warn
 * the user and simply don't register the tool, leaving it disabled.
 *
 * pi exposes no internal API to invoke a provider's Responses endpoint, so the
 * tool issues the HTTP request itself via fetch() — but auth (api key + headers)
 * is resolved through pi's model registry, never rolled by hand.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, type WebAccessConfig } from "./config.ts";
import { getAdapter, parseResponse } from "./providers.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Markdown theme reads the active theme lazily through its closures, so a single
// module-level instance stays correct across runtime theme switches.
const MARKDOWN_THEME = getMarkdownTheme();

/**
 * Resolve the configured model and its credentials from the registry. Shared by
 * session_start (validate-or-disable) and execute (re-resolve fresh each call,
 * so a mid-session credential/registry change is picked up). Callers decide how
 * to present a failure — notify-and-disable vs. throw.
 */
async function resolveModelAuth(
  modelRegistry: ModelRegistry,
  cfg: WebAccessConfig,
): Promise<
  | { ok: true; model: Model<Api>; apiKey: string; headers?: Record<string, string> }
  | { ok: false; error: string }
> {
  const model = modelRegistry.find(cfg.provider, cfg.model);
  if (!model) {
    return { ok: false, error: `model ${cfg.provider}/${cfg.model} is not in the model registry` };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, error: `auth failed for ${cfg.provider} (${auth.error})` };
  if (!auth.apiKey) return { ok: false, error: `no API key for ${cfg.provider}` };
  if (!model.baseUrl) return { ok: false, error: `no baseUrl found for ${cfg.provider}/${cfg.model}` };
  return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
}

function registerWebSearch(pi: ExtensionAPI, cfg: WebAccessConfig) {
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
      const resolved = await resolveModelAuth(ctx.modelRegistry, cfg);
      if (!resolved.ok) throw new Error(resolved.error);
      const { model, apiKey, headers } = resolved;

      const base = model.baseUrl;
      const body = adapter.buildBody(
        model.id,
        {
          query: params.query,
          maxResults: params.max_results,
          searchContextSize: params.search_context_size,
          allowedDomains: params.allowed_domains,
        },
        cfg.providerParams[cfg.provider] ?? {},
      );

      // Animate a throbber while the request is in flight: stream spinner frames
      // as partial content, which re-renders the result row (see renderResult).
      let frame = 0;
      const throbber = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        onUpdate?.({
          content: [{ type: "text", text: `${SPINNER_FRAMES[frame]} Searching the web…` }],
          details: undefined,
        });
      }, 120);

      let res: Response;
      let json: unknown;
      try {
        res = await fetch(`${base.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...headers,
          },
          body: JSON.stringify(body),
          signal: signal ?? ctx.signal,
        });
        if (!res.ok) {
          throw new Error(`web_search request failed (${res.status}): ${await res.text()}`);
        }
        json = await res.json();
      } finally {
        clearInterval(throbber);
      }

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

export default function (pi: ExtensionAPI) {
  // modelRegistry is only available on ExtensionContext, so validation (and the
  // registry/credential checks) must run in session_start, not the bare factory.
  pi.on("session_start", async (_event, ctx) => {
    const result = loadConfig(ctx.cwd);
    if (!result.ok) {
      ctx.ui.notify(`web-access disabled: ${result.error}`, "warning");
      return;
    }
    const cfg = result.config;

    // Validate the model + credentials up front; disable (don't register) on failure.
    const resolved = await resolveModelAuth(ctx.modelRegistry, cfg);
    if (!resolved.ok) {
      ctx.ui.notify(`web-access disabled: ${resolved.error}`, "warning");
      return;
    }

    registerWebSearch(pi, cfg);
  });
}
