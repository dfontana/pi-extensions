/**
 * mcp — a lean MCP client for pi.
 *
 * Reads standard `.mcp.json` (read-only), connects stdio + HTTP servers lazily,
 * caches tool metadata, and exposes every server through a single `mcp` proxy
 * tool (status / search / describe / call / connect / auth). Servers are curated
 * per session from the `/mcp` panel. See README.md for config + auth details.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  formatSize,
  keyHint,
  type Theme,
  type ThemeColor,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { authComplete, authInteractive, authStart } from "./auth.ts";
import { loadServers } from "./config.ts";
import { Manager, type ServerState } from "./manager.ts";

const manager = new Manager();
let ui: ExtensionUIContext | undefined;

// ---- compact single-line rendering for the mcp tool -----------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface McpRowState {
  done: boolean;
  isError: boolean;
  frameIdx: number;
  spinnerTimer?: ReturnType<typeof setInterval>;
  invalidateFn?: () => void;
}

/**
 * A minimal single-line component that renders exactly one ANSI-safe truncated line.
 * Used for both the spinner call header and the collapsed checkmark/cross line.
 */
class SingleLine {
  private content = "";
  private cachedWidth?: number;
  private cachedLine?: string;

  setText(content: string) {
    if (this.content !== content) {
      this.content = content;
      this.cachedWidth = undefined;
      this.cachedLine = undefined;
    }
  }

  render(width: number): string[] {
    if (this.cachedLine !== undefined && this.cachedWidth === width) return [this.cachedLine];
    this.cachedLine = truncateToWidth(this.content, width);
    this.cachedWidth = width;
    return [this.cachedLine];
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLine = undefined;
  }
}

/** Zero-height component — renders nothing when result is collapsed. */
const EMPTY_COMPONENT = { render: (_w: number): string[] => [], invalidate: () => {} };

/** Build the description + params strings for a given set of proxy args. */
function buildMcpLineParts(a: ProxyArgs | undefined): { mode: string; params: string } {
  if (!a) return { mode: "status", params: "" };
  if (a.action) return { mode: a.action, params: a.server ?? "" };
  if (a.tool) return { mode: `call ${a.tool}`, params: a.args ?? "" };
  if (a.search) return { mode: "search", params: `"${a.search}"` };
  if (a.describe) return { mode: "describe", params: a.describe };
  if (a.connect) return { mode: "connect", params: a.connect };
  if (a.server) return { mode: "list", params: a.server };
  return { mode: "status", params: "" };
}

/** Assemble the full colored line string. */
function buildMcpLine(
  prefix: string,
  mode: string,
  params: string,
  theme: Theme,
): string {
  let line = prefix + " " + theme.fg("toolTitle", theme.bold("mcp")) + " " + theme.fg("muted", mode);
  if (params) line += " " + theme.fg("dim", params);
  return line;
}

const ICON: Record<ServerState, string> = {
  off: "·",
  idle: "○",
  cached: "○",
  connected: "●",
  "needs-auth": "⚠",
  failed: "✗",
};
const STATE_COLOR: Record<ServerState, ThemeColor> = {
  off: "dim",
  idle: "muted",
  cached: "muted",
  connected: "success",
  "needs-auth": "warning",
  failed: "error",
};

const oneLine = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();
const asText = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

/** Parse the tool's `args` field (a JSON object string) into an object. */
function parseArgs(s?: string): Record<string, unknown> {
  if (!s) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`"args" must be a JSON object string: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error('"args" must be a JSON object string.');
  return parsed as Record<string, unknown>;
}

function qualify(server: string, tool: string): string {
  return `${server}_${tool}`;
}

function updateFooter(): void {
  if (!ui) return;
  const total = manager.servers.size;
  ui.setStatus("mcp", total ? ui.theme.fg("muted", `mcp ${manager.enabled.size}/${total}`) : undefined);
}

/** Resolve a tool reference (bare or `server_tool`) across enabled servers. */
async function resolve(
  arg: string,
): Promise<{ server: string; tool: string } | "none" | { ambiguous: string[] }> {
  const all = await manager.enabledMetadata();
  const matches = new Map<string, { server: string; tool: string }>();
  for (const [server, tools] of all) {
    for (const t of tools) {
      if (t.name === arg || arg === `${server}_${t.name}`) {
        matches.set(`${server}\0${t.name}`, { server, tool: t.name });
      }
    }
  }
  const found = [...matches.values()];
  if (found.length === 1) return found[0];
  if (found.length === 0) return "none";
  return { ambiguous: found.map((m) => `${m.server}_${m.tool}`) };
}

// ---- proxy tool modes (return plain text) ----------------------------------

function statusText(): string {
  const names = manager.list();
  if (!names.length) {
    return "No MCP servers configured. Add them to ./.mcp.json or ~/.config/mcp/mcp.json.";
  }
  const pad = Math.max(...names.map((n) => n.length));
  const rows = names.map((n) => {
    const st = manager.state(n);
    const count = manager.toolCount(n);
    const tools = count != null ? `${count} tool${count === 1 ? "" : "s"}` : "";
    let row = `${ICON[st]} ${n.padEnd(pad)}  ${st.padEnd(11)}  ${tools}`.trimEnd();
    if (st === "needs-auth") row += "  → authenticate from the /mcp panel";
    return row;
  });
  const hint =
    manager.enabled.size === 0
      ? "All servers are off — enable them from the /mcp panel, then discover tools with mcp({search:'…'})."
      : "Discover tools with mcp({search:'…'}) or mcp({server:'…'}); call with mcp({tool:'…', args:'{…}'}).";
  return `MCP servers (${manager.enabled.size}/${names.length} enabled):\n${rows.join("\n")}\n\n${hint}`;
}

async function listServerText(server: string): Promise<string> {
  const def = manager.servers.get(server);
  if (!def) return `Unknown server "${server}". Configured: ${manager.list().join(", ") || "none"}.`;
  if (!manager.enabled.has(server)) return `Server "${server}" is off — enable it from the /mcp panel.`;
  const tools = await manager.metadata(server);
  if (!tools.length) return `"${server}" exposes no tools.`;
  return (
    `"${server}" — ${tools.length} tools:\n` +
    tools.map((t) => `  ${qualify(server, t.name)}${t.description ? ` — ${oneLine(t.description)}` : ""}`).join("\n")
  );
}

async function searchText(query: string, regex?: boolean): Promise<string> {
  const all = await manager.enabledMetadata();
  if (!all.size) return "No enabled servers to search. Enable servers from the /mcp panel.";
  let test: (s: string) => boolean;
  if (regex) {
    if (query.length > 200) return "Regex too long (max 200 chars).";
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      return `Invalid regex: ${(e as Error).message}`;
    }
    test = (s) => re.test(s);
  } else {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return "Empty search query.";
    test = (s) => {
      const l = s.toLowerCase();
      return terms.some((t) => l.includes(t));
    };
  }
  const hits: string[] = [];
  for (const [server, tools] of all) {
    for (const t of tools) {
      if (test(`${t.name} ${t.description ?? ""}`)) {
        hits.push(`  ${qualify(server, t.name)}${t.description ? ` — ${oneLine(t.description)}` : ""}`);
      }
    }
  }
  if (!hits.length) return `No tools match "${query}".`;
  const shown = hits.slice(0, 50);
  return (
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}":\n${shown.join("\n")}` +
    (hits.length > shown.length ? `\n  … ${hits.length - shown.length} more` : "")
  );
}

async function describeText(arg: string): Promise<string> {
  const r = await resolve(arg);
  if (r === "none") return `Tool "${arg}" not found. Try mcp({search:'${arg}'}).`;
  if ("ambiguous" in r) return `"${arg}" is ambiguous: ${r.ambiguous.join(", ")}. Use a qualified name.`;
  const t = (await manager.metadata(r.server)).find((x) => x.name === r.tool)!;
  return [
    qualify(r.server, t.name),
    `server: ${r.server}`,
    "",
    t.description ?? "(no description)",
    "",
    "input schema:",
    JSON.stringify(t.inputSchema, null, 2),
  ].join("\n");
}

async function connectText(server: string): Promise<string> {
  const def = manager.servers.get(server);
  if (!def) return `Unknown server "${server}". Configured: ${manager.list().join(", ") || "none"}.`;
  manager.enabled.add(server); // enable the server (and connect) even if it was off
  const tools = await manager.connect(server);
  updateFooter();
  return `Connected "${server}" — ${tools.length} tools:\n` + tools.map((t) => `  ${qualify(server, t.name)}`).join("\n");
}

interface ProxyArgs {
  server?: string;
  search?: string;
  describe?: string;
  tool?: string;
  args?: string;
  connect?: string;
  regex?: boolean;
  action?: "auth-start" | "auth-complete";
}

async function callToolResult(p: ProxyArgs, signal?: AbortSignal) {
  const args = parseArgs(p.args);
  const r = await resolve(p.tool!);
  if (r === "none") {
    throw new Error(`Tool "${p.tool}" not found. Use mcp({search:'…'}) to discover tools, or enable its server from /mcp.`);
  }
  if ("ambiguous" in r) throw new Error(`Tool "${p.tool}" is ambiguous: ${r.ambiguous.join(", ")}.`);
  const out = await manager.callTool(r.server, r.tool, args, signal);
  updateFooter();
  if (out.isError) throw new Error(out.text);
  const t = truncateHead(out.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const body = t.truncated
    ? `${t.content}\n\n[truncated: ${t.outputLines}/${t.totalLines} lines, ${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}]`
    : t.content;
  return { content: [{ type: "text" as const, text: body }], details: { server: r.server, tool: r.tool } };
}

async function actionResult(p: ProxyArgs) {
  const server = p.server;
  if (!server) throw new Error(`${p.action} requires "server".`);
  const def = manager.servers.get(server);
  if (!def) throw new Error(`Unknown server "${server}".`);
  if (!def.url) throw new Error(`"${server}" is not an HTTP/OAuth server.`);

  if (p.action === "auth-start") {
    const url = await authStart(def);
    if (!url) return asText(`"${server}" is already authenticated.`);
    return asText(
      `Open this URL to authorize "${server}":\n${url}\n\n` +
        `After approving, your browser is redirected to a URL containing "?code=…". Finish with:\n` +
        `mcp({action:"auth-complete", server:"${server}", args:'{"redirectUrl":"<full redirect URL>"}'})`,
    );
  }
  // auth-complete
  const extra = parseArgs(p.args) as { redirectUrl?: string };
  if (!extra.redirectUrl) throw new Error('auth-complete requires args \'{"redirectUrl":"…"}\'.');
  await authComplete(def, extra.redirectUrl);
  manager.enabled.add(server);
  await manager.connect(server).catch(() => {});
  updateFooter();
  return asText(`"${server}" authenticated ✓`);
}

// ---- /mcp management panel -------------------------------------------------

const HELP = "↑↓ move · space toggle · r reconnect · a auth · esc close";

async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
  const names = manager.list();
  if (!names.length) {
    ctx.ui.notify("No MCP servers configured (./.mcp.json or ~/.config/mcp/mcp.json).", "warning");
    return;
  }

  const result = await ctx.ui.custom<{ auth: string } | undefined>((tui, theme, _kb, done) => {
    let focus = 0;
    const busy = new Map<string, string>();

    const border = (s: string) => theme.fg("dim", s);

    const contentRow = (inner: number, left: string, right: string): string => {
      const rw = visibleWidth(right);
      const leftFit = visibleWidth(left) > inner - rw - 1 ? truncateToWidth(left, inner - rw - 1, "…") : left;
      const gap = Math.max(1, inner - visibleWidth(leftFit) - rw);
      return border("│ ") + leftFit + " ".repeat(gap) + right + border(" │");
    };

    const serverRow = (name: string, inner: number, focused: boolean): string => {
      const st = manager.state(name);
      const transient = busy.get(name);
      const count = manager.toolCount(name);
      const detail = count != null && st !== "off" ? `${st} · ${count} tool${count === 1 ? "" : "s"}` : st;
      const right = transient
        ? theme.fg(transient.startsWith("✗") ? "error" : "warning", transient)
        : theme.fg(STATE_COLOR[st], detail);
      const cursor = focused ? theme.fg("accent", "▸") : " ";
      const icon = theme.fg(STATE_COLOR[st], ICON[st]);
      const label = focused ? theme.fg("accent", theme.bold(name)) : name;
      return contentRow(inner, `${cursor} ${icon} ${label}`, right);
    };

    const render = (width: number): string[] => {
      const w = Math.min(Math.max(width, 44), 78);
      const inner = w - 4;
      const title = theme.fg("accent", theme.bold("MCP servers"));
      const used = visibleWidth("╭─ MCP servers ");
      const lines = [border("╭─ ") + title + " " + border("─".repeat(Math.max(0, w - used - 1)) + "╮")];
      for (let i = 0; i < names.length; i++) lines.push(serverRow(names[i], inner, i === focus));
      lines.push(border("├" + "─".repeat(w - 2) + "┤"));
      lines.push(contentRow(inner, theme.fg("dim", HELP), ""));
      lines.push(border("╰" + "─".repeat(w - 2) + "╯"));
      return lines;
    };

    const reconnect = async (name: string) => {
      manager.enabled.add(name);
      busy.set(name, "connecting…");
      tui.requestRender();
      try {
        await manager.connect(name);
      } catch (e) {
        busy.set(name, `✗ ${oneLine((e as Error).message).slice(0, 40)}`);
        setTimeout(() => (busy.delete(name), tui.requestRender()), 4000);
      } finally {
        busy.delete(name);
        updateFooter();
        tui.requestRender();
      }
    };

    return {
      render,
      invalidate() {},
      handleInput(data: string) {
        const name = names[focus];
        if (matchesKey(data, "down") || matchesKey(data, "j")) focus = Math.min(focus + 1, names.length - 1);
        else if (matchesKey(data, "up") || matchesKey(data, "k")) focus = Math.max(focus - 1, 0);
        else if (matchesKey(data, "escape") || matchesKey(data, "q")) return done(undefined);
        else if (matchesKey(data, "space") || matchesKey(data, "return")) {
          if (manager.enabled.has(name)) manager.enabled.delete(name);
          else manager.enabled.add(name);
          updateFooter();
        } else if (matchesKey(data, "r")) void reconnect(name);
        else if (matchesKey(data, "a")) return done({ auth: name });
        tui.requestRender();
      },
    };
  });

  if (result?.auth) await runAuth(ctx, result.auth);
}

async function runAuth(ctx: ExtensionCommandContext, name: string): Promise<void> {
  const def = manager.servers.get(name);
  if (!def?.url) {
    ctx.ui.notify(`"${name}" is not an HTTP/OAuth server.`, "warning");
    return;
  }
  const ok = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Authorizing "${name}" — a browser window should open…`);
    loader.onAbort = () => done(false);
    authInteractive(def, loader.signal)
      .then(() => done(true))
      .catch((e) => (ctx.ui.notify(`"${name}" auth failed: ${(e as Error).message}`, "error"), done(false)));
    return loader;
  });
  if (ok) {
    manager.enabled.add(name);
    await manager.connect(name).catch(() => {});
    updateFooter();
    ctx.ui.notify(`"${name}" authenticated ✓`, "info");
  }
}

// ---- registration ----------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Proxy for configured MCP servers. Modes (pass exactly one): mcp({}) → server status; " +
      "mcp({server}) → list a server's tools; mcp({search}) → find tools across enabled servers; " +
      "mcp({describe}) → a tool's schema; mcp({tool, args}) → call a tool (args is a JSON object string); " +
      "mcp({connect}) → force connect + refresh; mcp({action}) → OAuth helpers.",
    promptSnippet: "Reach MCP servers: status mcp({}), search, describe, and call tools via mcp({tool, args})",
    promptGuidelines: [
      "Use mcp to reach MCP servers: mcp({}) for status, mcp({search:'…'}) to find tools, mcp({describe:'…'}) for a tool's schema, then mcp({tool:'…', args:'{…}'}) to call it. Only enabled servers are reachable — if a needed server is off, ask the user to enable it from the /mcp panel.",
    ],
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "List this server's tools (cache or lazy connect)." })),
      search: Type.Optional(
        Type.String({ description: "Search tool names/descriptions across enabled servers; space-separated terms are OR'd." }),
      ),
      describe: Type.Optional(Type.String({ description: "Show one tool's server, description, and input schema." })),
      tool: Type.Optional(Type.String({ description: "Tool to call (bare name or server-prefixed)." })),
      args: Type.Optional(Type.String({ description: "JSON object string of arguments for the tool (or for auth-complete)." })),
      connect: Type.Optional(Type.String({ description: "Force a connect + metadata refresh for this server." })),
      regex: Type.Optional(Type.Boolean({ description: "Treat the search query as a case-insensitive regular expression." })),
      action: Type.Optional(
        StringEnum(["auth-start", "auth-complete"] as const, {
          description: "OAuth helpers: auth-start returns a URL; auth-complete takes {redirectUrl} via args.",
        }),
      ),
    }),

    renderCall(args, theme, context) {
      const state = context.state as McpRowState;
      // Lazily initialise state fields the first time renderCall fires.
      state.done ??= false;
      state.isError ??= false;
      state.frameIdx ??= 0;

      const comp = (context.lastComponent as SingleLine | undefined) ?? new SingleLine();

      // Keep the invalidate reference fresh so the timer always reaches the live fn.
      state.invalidateFn = context.invalidate;

      const a = args as ProxyArgs | undefined;
      const { mode, params } = buildMcpLineParts(a);

      if (!state.done) {
        // Start the spinner timer once.
        if (!state.spinnerTimer) {
          state.frameIdx = 0;
          state.spinnerTimer = setInterval(() => {
            state.frameIdx = (state.frameIdx + 1) % SPINNER_FRAMES.length;
            comp.invalidate();
            state.invalidateFn?.();
          }, 80);
        }
        const spinChar = theme.fg("dim", SPINNER_FRAMES[state.frameIdx] ?? SPINNER_FRAMES[0]);
        comp.setText(buildMcpLine(spinChar, mode, params, theme));
      } else {
        // Execution finished — show checkmark or cross.
        const icon = state.isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const hint = keyHint("app.tools.expand", "expand");
        comp.setText(buildMcpLine(icon, mode, params, theme) + " " + theme.fg("dim", hint));
      }

      return comp;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as McpRowState;

      // On first final result: stop spinner and trigger call slot to re-render with icon.
      if (!isPartial && !state.done) {
        state.done = true;
        state.isError = context.isError;
        if (state.spinnerTimer) {
          clearInterval(state.spinnerTimer);
          state.spinnerTimer = undefined;
        }
        context.invalidate(); // re-render renderCall with ✓ / ✗
      }

      if (!expanded) {
        // Collapsed: renderCall already shows the summary — render nothing here.
        return EMPTY_COMPONENT;
      }

      // Expanded: full request + response details.
      const a = context.args as ProxyArgs | undefined;
      const lines: string[] = [];

      // Show call parameters.
      if (a?.tool && a.args && a.args !== "{}") {
        lines.push(theme.fg("muted", "args: ") + theme.fg("dim", a.args));
      } else if (a?.search) {
        lines.push(theme.fg("muted", "query: ") + theme.fg("dim", a.search));
      } else if (a?.describe) {
        lines.push(theme.fg("muted", "tool: ") + theme.fg("dim", a.describe));
      } else if (a?.server) {
        lines.push(theme.fg("muted", "server: ") + theme.fg("dim", a.server));
      } else if (a?.connect) {
        lines.push(theme.fg("muted", "connect: ") + theme.fg("dim", a.connect));
      }

      // Show result content.
      const content = result.content[0];
      if (content?.type === "text") {
        const color = state.isError ? "error" : "dim";
        lines.push(...content.text.split("\n").map((l) => theme.fg(color, l)));
      }

      return new Text(lines.join("\n"), 0, 0);
    },

    async execute(_id, p: ProxyArgs, signal, _onUpdate, ctx) {
      ui = ctx.ui;
      if (p.action) return actionResult(p);
      if (p.tool) return callToolResult(p, signal ?? ctx.signal);
      if (p.connect) return asText(await connectText(p.connect));
      if (p.describe) return asText(await describeText(p.describe));
      if (p.search) return asText(await searchText(p.search, p.regex));
      if (p.server) return asText(await listServerText(p.server));
      return asText(statusText());
    },
  });

  pi.registerCommand("mcp", {
    description: "Open the MCP server panel (enable/disable · reconnect · authenticate)",
    handler: async (_argStr, ctx) => {
      ui = ctx.ui;
      await openPanel(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    manager.load(loadServers(ctx.cwd));
    manager.enabled = new Set(); // servers default off — curate per session via /mcp
    updateFooter();
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
}
