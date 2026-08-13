/**
 * mcp — a lean MCP client for pi.
 *
 * Reads standard `.mcp.json` (read-only), connects stdio + HTTP servers
 * lazily, caches tool metadata, and exposes every server through a single
 * `mcp` proxy tool. Connection and OAuth authentication are fully implicit:
 * the agent never needs to connect or authenticate manually. Required user
 * recovery is through the /mcp panel (Shift+R to restart, Shift+A to force
 * re-authentication).
 *
 * Child agents inherit a validated point-in-time copy of the parent's enabled
 * server set through a child-only environment handoff. Connections and later
 * enable/disable changes remain isolated between processes.
 *
 * See README.md for config details.
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
import { decodeKittyPrintable, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AuthError, authInteractive, clearOAuthCredentials } from "./auth.ts";
import { loadServers } from "./config.ts";
import {
  consumeEnabledSnapshot,
  MCP_ENABLED_SNAPSHOT_ENV,
  serializeEnabledSnapshot,
} from "./handoff.ts";
import { Manager, type ServerState } from "./manager.ts";
import { registerSubagentEnvironmentProvider } from "../subagent/environment.ts";

interface Runtime {
  manager: Manager;
  ui?: ExtensionUIContext;
}

// ---- action definitions ---------------------------------------------------

export const MCP_ACTIONS = [
  "status",
  "list-tools",
  "search-tools",
  "describe-tool",
  "invoke-tool",
] as const;

type McpArgs =
  | { action: "status" }
  | { action: "list-tools"; server: string }
  | { action: "search-tools"; search: string; regex?: boolean }
  | { action: "describe-tool"; tool: string }
  | { action: "invoke-tool"; tool: string; args?: string };

function assertNever(x: never): never {
  throw new Error(`Unhandled MCP action: ${JSON.stringify((x as { action?: string }).action)}`);
}

// ---- hybrid provider-compatible schema ------------------------------------
//
// modelFacingRoot: a root Type.Object that Anthropic (and any adapter that
// only forwards root properties/required) can present as a meaningful object
// schema with required "action" and all argument descriptions.
//
// exactVariants: five exact Type.Object branches (each additionalProperties:
// false) representing the precise valid call shapes.
//
// mcpParameters: Type.Unsafe combines the root object fields with the
// anyOf union. Providers that forward the full schema get exact union
// enforcement; Anthropic gets the root object projection; TypeBox's local
// validator enforces anyOf for all providers.

const modelFacingRoot = Type.Object(
  {
    action: StringEnum(MCP_ACTIONS, {
      description: `MCP operation to perform. Choose exactly one action: ${MCP_ACTIONS.join(", ")}.`,
    }),
    server: Type.Optional(
      Type.String({ description: "Required only for list-tools: the server name to list tools from." }),
    ),
    search: Type.Optional(
      Type.String({ description: "Required only for search-tools: query string; space-separated terms are OR'd." }),
    ),
    regex: Type.Optional(
      Type.Boolean({
        description: "Optional only for search-tools: treat the query as a case-insensitive regex (default false).",
      }),
    ),
    tool: Type.Optional(
      Type.String({ description: "Required for describe-tool and invoke-tool: bare or server-prefixed tool name." }),
    ),
    args: Type.Optional(
      Type.String({ description: "Optional only for invoke-tool: JSON object string of arguments for the tool." }),
    ),
  },
  { additionalProperties: false },
);

const exactVariants = Type.Union([
  Type.Object(
    { action: StringEnum(["status"] as const) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: StringEnum(["list-tools"] as const), server: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: StringEnum(["search-tools"] as const),
      search: Type.String(),
      regex: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: StringEnum(["describe-tool"] as const), tool: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: StringEnum(["invoke-tool"] as const),
      tool: Type.String(),
      args: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

const mcpParameters = Type.Unsafe<McpArgs>({
  ...modelFacingRoot,
  anyOf: exactVariants.anyOf,
});

// ---- compact single-line rendering for the mcp tool -----------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface McpRowState {
  done: boolean;
  isError: boolean;
  frameIdx: number;
  spinnerTimer?: ReturnType<typeof setInterval>;
  invalidateFn?: () => void;
}

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

const EMPTY_COMPONENT = { render: (_w: number): string[] => [], invalidate: () => {} };

function buildMcpLineParts(a: McpArgs | undefined): { mode: string; params: string } {
  if (!a) return { mode: "status", params: "" };
  switch (a.action) {
    case "status":
      return { mode: "status", params: "" };
    case "list-tools":
      return { mode: "list", params: a.server };
    case "search-tools":
      return { mode: "search", params: `"${a.search}"` };
    case "describe-tool":
      return { mode: "describe", params: a.tool };
    case "invoke-tool":
      return { mode: `call ${a.tool}`, params: a.args ?? "" };
    default:
      return assertNever(a);
  }
}

function buildMcpLine(prefix: string, mode: string, params: string, theme: Theme): string {
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

function updateFooter(runtime: Runtime): void {
  if (!runtime.ui) return;
  const total = runtime.manager.servers.size;
  runtime.ui.setStatus(
    "mcp",
    total ? runtime.ui.theme.fg("muted", `mcp ${runtime.manager.enabled.size}/${total}`) : undefined,
  );
}

/** Resolve a bare or qualified tool reference across enabled servers. */
async function resolve(
  runtime: Runtime,
  arg: string,
): Promise<{ server: string; tool: string } | "none" | { ambiguous: string[] }> {
  const { meta } = await runtime.manager.enabledMetadata();
  const matches = new Map<string, { server: string; tool: string }>();
  for (const [server, tools] of meta) {
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

function statusText(runtime: Runtime): string {
  const { manager } = runtime;
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
    if (st === "needs-auth") {
      row += "  → authentication failed; use /mcp (Shift+A) to re-authenticate";
    }
    return row;
  });
  const hint =
    manager.enabled.size === 0
      ? `All servers are off — enable them from the /mcp panel, then discover tools with mcp({ action: "search-tools", search: "…" }).`
      : `Discover tools with mcp({ action: "search-tools", search: "…" }) or mcp({ action: "list-tools", server: "…" }); call with mcp({ action: "invoke-tool", tool: "…", args: "{…}" }).`;
  return `MCP servers (${manager.enabled.size}/${names.length} enabled):\n${rows.join("\n")}\n\n${hint}`;
}

async function listServerText(runtime: Runtime, server: string): Promise<string> {
  const { manager } = runtime;
  const def = manager.servers.get(server);
  if (!def) return `Unknown server "${server}". Configured: ${manager.list().join(", ") || "none"}.`;
  if (!manager.enabled.has(server)) return `Server "${server}" is off — enable it from the /mcp panel.`;

  // Check auth latch before attempting metadata fetch.
  const authFailures = manager.getAuthFailures();
  const authMsg = authFailures.get(server);
  if (authMsg) return authMsg;

  try {
    const tools = await manager.metadata(server);
    if (!tools.length) return `"${server}" exposes no tools.`;
    return (
      `"${server}" — ${tools.length} tools:\n` +
      tools.map((t) => `  ${qualify(server, t.name)}${t.description ? ` — ${oneLine(t.description)}` : ""}`).join("\n")
    );
  } catch (e) {
    if (e instanceof AuthError) return e.message;
    throw e;
  }
}

async function searchText(runtime: Runtime, query: string, regex?: boolean): Promise<string> {
  const { meta, authFailed } = await runtime.manager.enabledMetadata();
  if (!meta.size && !authFailed.size) {
    return "No enabled servers to search. Enable servers from the /mcp panel.";
  }

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
  for (const [server, tools] of meta) {
    for (const t of tools) {
      if (test(`${t.name} ${t.description ?? ""}`)) {
        hits.push(`  ${qualify(server, t.name)}${t.description ? ` — ${oneLine(t.description)}` : ""}`);
      }
    }
  }

  const skipped = [...authFailed.keys()];
  const skipLine =
    skipped.length > 0
      ? `\n\nNote: ${skipped.length} enabled server${skipped.length === 1 ? " was" : "s were"} skipped due to authentication failure: ${skipped.join(", ")}. Use /mcp (Shift+A) to re-authenticate.`
      : "";

  if (!hits.length) {
    return `No tools match "${query}".${skipLine}`;
  }
  const shown = hits.slice(0, 50);
  return (
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}":\n${shown.join("\n")}` +
    (hits.length > shown.length ? `\n  … ${hits.length - shown.length} more` : "") +
    skipLine
  );
}

async function describeText(runtime: Runtime, arg: string): Promise<string> {
  const { manager } = runtime;
  const r = await resolve(runtime, arg);
  if (r === "none") {
    // Surface any relevant auth failures rather than claiming absence.
    const authFailures = manager.getAuthFailures();
    if (authFailures.size > 0) {
      const lines = [...authFailures.entries()].map(([s, m]) => `  "${s}": ${m}`);
      return (
        `Tool "${arg}" not found in accessible servers. Try mcp({ action: "search-tools", search: "${arg}" }).\n\n` +
        `Enabled servers unavailable due to authentication failure:\n${lines.join("\n")}`
      );
    }
    return `Tool "${arg}" not found. Try mcp({ action: "search-tools", search: "${arg}" }).`;
  }
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

async function callToolResult(
  runtime: Runtime,
  p: Extract<McpArgs, { action: "invoke-tool" }>,
  signal?: AbortSignal,
) {
  const { manager } = runtime;
  const args = parseArgs(p.args);
  const r = await resolve(runtime, p.tool);
  if (r === "none") {
    const authFailures = manager.getAuthFailures();
    if (authFailures.size > 0) {
      const names = [...authFailures.keys()].join(", ");
      throw new Error(
        `Tool "${p.tool}" not found in accessible servers. Enabled servers unavailable due to authentication failure: ${names}. Use /mcp (Shift+A) to re-authenticate.`,
      );
    }
    throw new Error(
      `Tool "${p.tool}" not found. Use mcp({ action: "search-tools", search: "…" }) to discover tools, or enable its server from /mcp.`,
    );
  }
  if ("ambiguous" in r) throw new Error(`Tool "${p.tool}" is ambiguous: ${r.ambiguous.join(", ")}.`);
  try {
    const out = await manager.callTool(r.server, r.tool, args, signal);
    updateFooter(runtime);
    if (out.isError) throw new Error(out.text);
    const t = truncateHead(out.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    const body = t.truncated
      ? `${t.content}\n\n[truncated: ${t.outputLines}/${t.totalLines} lines, ${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}]`
      : t.content;
    return { content: [{ type: "text" as const, text: body }], details: { server: r.server, tool: r.tool } };
  } catch (e) {
    if (e instanceof AuthError) throw new Error(e.message);
    throw e;
  }
}

// ---- /mcp management panel -------------------------------------------------

const HELP = "type filter · ↑↓ · space toggle · R restart · A re-auth · esc";

function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded) return decoded;
  return [...data].length === 1 && !/[\u0000-\u001F\u007F-\u009F]/u.test(data) ? data : undefined;
}

async function openPanel(runtime: Runtime, ctx: ExtensionCommandContext): Promise<void> {
  const { manager } = runtime;
  const names = manager.list();
  if (!names.length) {
    ctx.ui.notify("No MCP servers configured (./.mcp.json or ~/.config/mcp/mcp.json).", "warning");
    return;
  }

  const result = await ctx.ui.custom<{ auth: string } | undefined>((tui, theme, _kb, done) => {
    let filter = "";
    let focusedName: string | undefined = names[0];
    const busy = new Map<string, string>();

    const border = (s: string) => theme.fg("dim", s);
    const visibleNames = () => {
      const query = filter.toLowerCase();
      return names.filter((name) => name.toLowerCase().includes(query));
    };
    const selectedName = () => {
      const visible = visibleNames();
      return focusedName && visible.includes(focusedName) ? focusedName : visible[0];
    };
    const moveFocus = (offset: number) => {
      const visible = visibleNames();
      if (!visible.length) return;
      const current = selectedName();
      const index = current ? visible.indexOf(current) : 0;
      focusedName = visible[Math.max(0, Math.min(index + offset, visible.length - 1))];
    };

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
      const visible = visibleNames();
      const selected = selectedName();
      const title = theme.fg("accent", theme.bold("MCP servers"));
      const used = visibleWidth("╭─ MCP servers ");
      const lines = [border("╭─ ") + title + " " + border("─".repeat(Math.max(0, w - used - 1)) + "╮")];
      lines.push(contentRow(inner, theme.fg("muted", `filter: ${filter}█`), theme.fg("dim", `${visible.length}/${names.length}`)));
      if (visible.length) {
        for (const name of visible) lines.push(serverRow(name, inner, name === selected));
      } else {
        lines.push(contentRow(inner, theme.fg("dim", "No matching MCP servers."), ""));
      }
      lines.push(border("├" + "─".repeat(w - 2) + "┤"));
      lines.push(contentRow(inner, theme.fg("dim", HELP), ""));
      lines.push(border("╰" + "─".repeat(w - 2) + "╯"));
      return lines;
    };

    const restart = async (name: string) => {
      // Clear any auth latch so Shift+R is not blocked by a prior automatic failure.
      manager.clearAuthLatch(name);
      manager.enabled.add(name);
      busy.set(name, "connecting…");
      tui.requestRender();
      try {
        await manager.connect(name);
        busy.delete(name); // success: clear status immediately
      } catch (e) {
        busy.set(name, `✗ ${oneLine((e as Error).message).slice(0, 40)}`);
        // Leave the error visible; schedule cleanup after a short display window.
        setTimeout(() => (busy.delete(name), tui.requestRender()), 4000);
      } finally {
        // Always refresh footer and re-render regardless of outcome.
        updateFooter(runtime);
        tui.requestRender();
      }
    };

    return {
      render,
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.down)) moveFocus(1);
        else if (matchesKey(data, Key.up)) moveFocus(-1);
        else if (matchesKey(data, Key.backspace)) filter = [...filter].slice(0, -1).join("");
        else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
          const name = selectedName();
          if (name) {
            if (manager.enabled.has(name)) manager.enabled.delete(name);
            else manager.enabled.add(name);
            updateFooter(runtime);
          }
        } else if (matchesKey(data, Key.shift("r"))) {
          const name = selectedName();
          if (name) void restart(name);
        } else if (matchesKey(data, Key.shift("a"))) {
          const name = selectedName();
          if (name) return done({ auth: name });
        } else {
          const text = printableInput(data);
          if (text) filter += text;
        }
        tui.requestRender();
      },
    };
  });

  if (result?.auth) await runAuth(runtime, ctx, result.auth);
}

async function runAuth(runtime: Runtime, ctx: ExtensionCommandContext, name: string): Promise<void> {
  const { manager } = runtime;
  const def = manager.servers.get(name);
  if (!def?.url) {
    ctx.ui.notify(`"${name}" is not an HTTP/OAuth server.`, "warning");
    return;
  }
  // Shift+A means *re*-authenticate: clear credentials, clear any auth latch,
  // then run a fresh interactive flow.
  await manager.disconnect(name);
  manager.clearAuthLatch(name);
  clearOAuthCredentials(def);
  const ok = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Re-authorizing "${name}" — a browser window should open…`);
    loader.onAbort = () => done(false);
    authInteractive(def, { signal: loader.signal })
      .then(() => done(true))
      .catch((e) => (ctx.ui.notify(`"${name}" auth failed: ${(e as Error).message}`, "error"), done(false)));
    return loader;
  });
  if (ok) {
    manager.enabled.add(name);
    await manager.connect(name).catch(() => {});
    updateFooter(runtime);
    ctx.ui.notify(`"${name}" authenticated ✓`, "info");
  }
}

// ---- registration ----------------------------------------------------------

function registerMcpTool(pi: ExtensionAPI, runtime: Runtime, configuredServers: string[] = []): void {
  const actionList = MCP_ACTIONS.join(", ");
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Proxy for configured MCP servers. " +
      `Choose exactly one action: ${actionList}. ` +
      'mcp({ action: "status" }) → server status; ' +
      'mcp({ action: "list-tools", server: "…" }) → list a server\'s tools; ' +
      'mcp({ action: "search-tools", search: "…" }) → find tools across enabled servers; ' +
      'mcp({ action: "describe-tool", tool: "…" }) → a tool\'s schema; ' +
      'mcp({ action: "invoke-tool", tool: "…", args: "{…}" }) → call a tool (args is a JSON object string). ' +
      "Connection and authentication are implicit — do not attempt to connect or authenticate manually. " +
      "If a server is unavailable due to authentication failure, escalate to the user to recover via " +
      "the /mcp panel (Shift+R to restart, Shift+A to force re-authentication). " +
      "Only enabled servers are reachable — the user controls enablement through /mcp.",
    promptSnippet:
      `Reach MCP servers via the mcp tool with action: ${actionList}. ` +
      'Status: mcp({ action: "status" }); ' +
      'search: mcp({ action: "search-tools", search: "…" }); ' +
      'describe: mcp({ action: "describe-tool", tool: "…" }); ' +
      'call: mcp({ action: "invoke-tool", tool: "…", args: "{…}" })' +
      (configuredServers.length ? `. Configured MCP servers: ${configuredServers.join(", ")}.` : ""),
    promptGuidelines: [
      `Use mcp to reach MCP servers. Choose exactly one action: ${actionList}. ` +
        'mcp({ action: "status" }) for server status; ' +
        'mcp({ action: "list-tools", server: "…" }) to list a server\'s tools (cache or lazy connect); ' +
        'mcp({ action: "search-tools", search: "…" }) to find tools across enabled servers (space-separated terms are OR\'d; regex: true for regex mode); ' +
        'mcp({ action: "describe-tool", tool: "…" }) for one tool\'s server, description, and input schema; ' +
        'mcp({ action: "invoke-tool", tool: "…", args: "{…}" }) to call a tool (args is a JSON object string; tool may be bare or server_tool). ' +
        "Only enabled servers are reachable — if a needed server is off, ask the user to enable it from the /mcp panel.",
      "Connection and OAuth authentication are fully automatic — do not attempt to trigger a connection or authenticate manually. If authentication fails, tell the user and ask them to recover via /mcp (Shift+R to restart, Shift+A to re-authenticate). Do not retry authentication automatically.",
    ],
    parameters: mcpParameters,

    renderCall(args, theme, context) {
      const state = context.state as McpRowState;
      state.done ??= false;
      state.isError ??= false;
      state.frameIdx ??= 0;

      const comp = (context.lastComponent as SingleLine | undefined) ?? new SingleLine();
      state.invalidateFn = context.invalidate;

      const a = args as McpArgs | undefined;
      const { mode, params } = buildMcpLineParts(a);

      if (!state.done) {
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
        const icon = state.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const hint = keyHint("app.tools.expand", "expand");
        comp.setText(buildMcpLine(icon, mode, params, theme) + " " + theme.fg("dim", hint));
      }

      return comp;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as McpRowState;

      if (!isPartial && !state.done) {
        state.done = true;
        state.isError = context.isError;
        if (state.spinnerTimer) {
          clearInterval(state.spinnerTimer);
          state.spinnerTimer = undefined;
        }
        context.invalidate();
      }

      if (!expanded) return EMPTY_COMPONENT;

      const a = context.args as McpArgs | undefined;
      const lines: string[] = [];

      if (a) {
        switch (a.action) {
          case "status":
            break;
          case "list-tools":
            lines.push(theme.fg("muted", "server: ") + theme.fg("dim", a.server));
            break;
          case "search-tools":
            lines.push(theme.fg("muted", "query: ") + theme.fg("dim", a.search));
            break;
          case "describe-tool":
            lines.push(theme.fg("muted", "tool: ") + theme.fg("dim", a.tool));
            break;
          case "invoke-tool":
            if (a.args && a.args !== "{}") {
              lines.push(theme.fg("muted", "args: ") + theme.fg("dim", a.args));
            }
            break;
          default:
            assertNever(a);
        }
      }

      const content = result.content[0];
      if (content?.type === "text") {
        const color = state.isError ? "error" : "dim";
        lines.push(...content.text.split("\n").map((l) => theme.fg(color, l)));
      }

      return new Text(lines.join("\n"), 0, 0);
    },

    async execute(_id, p: McpArgs, signal, _onUpdate, ctx) {
      runtime.ui = ctx.ui;
      switch (p.action) {
        case "status":
          return asText(statusText(runtime));
        case "list-tools":
          return asText(await listServerText(runtime, p.server));
        case "search-tools":
          return asText(await searchText(runtime, p.search, p.regex));
        case "describe-tool":
          return asText(await describeText(runtime, p.tool));
        case "invoke-tool":
          return callToolResult(runtime, p, signal ?? ctx.signal);
        default:
          return assertNever(p);
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  const runtime: Runtime = { manager: new Manager() };

  registerMcpTool(pi, runtime);

  // Capture the enabled set immediately before each child process starts.
  // Parallel launches receive independent values and nothing is written to disk.
  const unregisterEnvironmentProvider = registerSubagentEnvironmentProvider("mcp", (): Record<string, string> => {
    const serialized = serializeEnabledSnapshot(runtime.manager.snapshot());
    if (!serialized) return {};
    return { [MCP_ENABLED_SNAPSHOT_ENV]: serialized };
  });

  // ---- Session lifecycle ---------------------------------------------------

  pi.registerCommand("mcp", {
    description: "Open the searchable MCP server panel (enable/disable · restart · authenticate)",
    handler: async (_argStr, ctx) => {
      runtime.ui = ctx.ui;
      await openPanel(runtime, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime.ui = ctx.ui;
    const servers = loadServers(ctx.cwd);

    // Consume before initializing. The handoff helper always deletes the
    // environment value, including malformed input, to prevent propagation.
    const inheritedSnapshot = consumeEnabledSnapshot();
    await runtime.manager.initialize(servers, inheritedSnapshot);
    registerMcpTool(pi, runtime, runtime.manager.list());
    updateFooter(runtime);
  });

  pi.on("session_shutdown", async () => {
    unregisterEnvironmentProvider();
    runtime.ui?.setStatus("mcp", undefined);
    runtime.ui = undefined;
    await runtime.manager.shutdown();
  });
}
