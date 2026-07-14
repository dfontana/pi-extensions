/**
 * Connection + metadata manager.
 *
 * Servers are never connected at startup. Tool metadata is served from a
 * persistent cache (`~/.pi/agent/mcp/cache.json`, keyed by server identity hash)
 * so status/list/search/describe work offline; a missing or stale cache, or an
 * actual tool call, triggers a lazy connect. Live connections idle-disconnect
 * after `IDLE_TIMEOUT_MS`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bearerHeaders, oauthProvider } from "./auth.ts";
import { identity, readState, type ServerDef, transportKind, writeState } from "./config.ts";

export interface ToolMeta {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type ServerState = "off" | "idle" | "cached" | "connected" | "needs-auth" | "failed";

const CACHE_FILE = "cache.json";
const CACHE_TTL = 7 * 24 * 60 * 60_000;
// After a failed connect, don't re-spawn on implicit (search/list) paths for a
// while — avoids tight reconnect loops against a broken or unauthenticated server.
const FAIL_COOLDOWN = 60_000;
// Disconnect a live connection after this much idle time (set to 0 to keep open).
const IDLE_TIMEOUT_MS = 10 * 60_000;

type Cache = Record<string, { savedAt: number; tools: ToolMeta[] }>;

type Failure = { kind: "needs-auth" | "error"; message: string; at: number };

const needsAuthMessage = (name: string) => `"${name}" needs authentication — authenticate it from the /mcp panel`;

/**
 * Preserve the caller's environment for trusted, locally configured MCPs.
 *
 * The MCP SDK otherwise replaces it with a small safe-variable allowlist,
 * which breaks local tools that rely on an SSH agent, GPG, or a credential
 * store. Keep its protection against shell-function environment values, then
 * let an explicit server configuration take precedence.
 */
export function stdioEnvironment(overrides?: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[1].startsWith("()"),
    ),
  );
  return { ...inherited, ...overrides };
}

interface Conn {
  client: Client;
  idle?: NodeJS.Timeout;
}

// OAuth credentials are deliberately shared across session-local managers. Keep
// only the credential-sensitive connection establishment serialized, keyed by
// the server URL; stdio and bearer-token servers remain fully parallel.
const oauthConnectLocks = new Map<string, Promise<void>>();

async function withOAuthConnectLock<T>(url: string, work: () => Promise<T>): Promise<T> {
  const previous = oauthConnectLocks.get(url) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  oauthConnectLocks.set(url, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (oauthConnectLocks.get(url) === tail) oauthConnectLocks.delete(url);
  }
}

export class Manager {
  servers = new Map<string, ServerDef>();
  enabled = new Set<string>();

  private conns = new Map<string, Conn>();
  private connecting = new Map<string, Promise<ToolMeta[]>>();
  private meta = new Map<string, ToolMeta[]>();
  private fails = new Map<string, Failure>();
  private cacheFile?: Cache;

  /** Reset this session-local manager for a new extension session. */
  async initialize(servers: Map<string, ServerDef>): Promise<void> {
    // Let an existing establishment finish before closing it, so it cannot add
    // a stale connection after this reset has completed.
    await Promise.allSettled([...this.connecting.values()]);
    await this.shutdown();
    this.servers = servers;
    this.enabled.clear();
    this.meta.clear();
    this.fails.clear();
    this.cacheFile = undefined; // re-read cache.json next access (another session may have written it)
    this.connecting.clear();
  }

  list(): string[] {
    return [...this.servers.keys()].sort();
  }

  // ---- cache ----------------------------------------------------------------

  // Parsed once and kept in memory — status/list read this per render, so the
  // whole cache file shouldn't be re-parsed from disk on every state() call.
  private cache(): Cache {
    return (this.cacheFile ??= readState<Cache>(CACHE_FILE, {}));
  }

  private cached(def: ServerDef): ToolMeta[] | undefined {
    const entry = this.cache()[identity(def)];
    return entry && Date.now() - entry.savedAt < CACHE_TTL ? entry.tools : undefined;
  }

  private saveCache(def: ServerDef, tools: ToolMeta[]): void {
    const cache = this.cache();
    cache[identity(def)] = { savedAt: Date.now(), tools };
    writeState(CACHE_FILE, cache);
  }

  toolCount(name: string): number | undefined {
    const known = this.meta.get(name);
    if (known) return known.length;
    const def = this.servers.get(name);
    return def && this.cached(def)?.length;
  }

  // ---- connect / disconnect -------------------------------------------------

  private transport(def: ServerDef, kind: "stdio" | "http") {
    if (kind === "stdio") {
      return new StdioClientTransport({
        command: def.command!,
        args: def.args,
        cwd: def.cwd,
        env: stdioEnvironment(def.env),
        stderr: "ignore",
      });
    }
    const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
    if (def.auth === "oauth") opts.authProvider = oauthProvider(def);
    const headers = { ...def.headers, ...(def.auth === "bearer" ? bearerHeaders(def) : {}) };
    if (Object.keys(headers).length) opts.requestInit = { headers };
    return new StreamableHTTPClientTransport(new URL(def.url!), opts);
  }

  async connect(name: string): Promise<ToolMeta[]> {
    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const attempt = this.connectNow(name).finally(() => this.connecting.delete(name));
    this.connecting.set(name, attempt);
    return attempt;
  }

  private async connectNow(name: string): Promise<ToolMeta[]> {
    const def = this.servers.get(name);
    if (!def) throw new Error(`unknown server "${name}"`);
    const kind = transportKind(def);
    if (kind === "invalid") throw new Error(`server "${name}" has neither "command" nor "url"`);

    const establish = async (): Promise<ToolMeta[]> => {
      await this.disconnect(name);
      const client = new Client({ name: "pi-mcp", version: "1.0.0" });
      const transport = this.transport(def, kind);
      const conn: Conn = { client };
      // A delayed close from an old transport must not disconnect a newer one.
      transport.onclose = () => {
        if (this.conns.get(name) === conn) void this.disconnect(name, conn);
      };
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const meta = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        this.fails.delete(name);
        this.meta.set(name, meta);
        this.saveCache(def, meta);
        this.conns.set(name, conn);
        this.touch(name);
        return meta;
      } catch (e) {
        await client.close().catch(() => {});
        if (e instanceof UnauthorizedError) {
          const message = needsAuthMessage(name);
          this.fails.set(name, { kind: "needs-auth", message, at: Date.now() });
          throw new Error(message);
        }
        const message = `"${name}" failed to connect: ${e instanceof Error ? e.message : String(e)}`;
        this.fails.set(name, { kind: "error", message, at: Date.now() });
        throw new Error(message);
      }
    };

    return kind === "http" && def.auth === "oauth" ? withOAuthConnectLock(def.url!, establish) : establish();
  }

  async disconnect(name: string, expected?: Conn): Promise<void> {
    const conn = this.conns.get(name);
    if (!conn || (expected && conn !== expected)) return;
    if (conn.idle) clearTimeout(conn.idle);
    this.conns.delete(name);
    await conn.client.close().catch(() => {});
  }

  private touch(name: string): void {
    const conn = this.conns.get(name);
    if (!conn) return;
    if (conn.idle) clearTimeout(conn.idle);
    if (IDLE_TIMEOUT_MS > 0) {
      conn.idle = setTimeout(() => void this.disconnect(name), IDLE_TIMEOUT_MS);
      conn.idle.unref();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }

  // ---- metadata (cache-first, lazy connect) ---------------------------------

  async metadata(name: string): Promise<ToolMeta[]> {
    const known = this.meta.get(name);
    if (known) return known;
    const def = this.servers.get(name);
    if (!def) throw new Error(`unknown server "${name}"`);
    const cached = this.cached(def);
    if (cached) {
      this.meta.set(name, cached);
      return cached;
    }
    // Respect the failure cooldown on this implicit path (explicit connect() ignores it).
    const fail = this.fails.get(name);
    if (fail && Date.now() - fail.at < FAIL_COOLDOWN) throw new Error(fail.message);
    return this.connect(name);
  }

  /** Metadata for every enabled server, best-effort (skips ones that error). */
  async enabledMetadata(): Promise<Map<string, ToolMeta[]>> {
    // Independent servers fetch concurrently; cold connects no longer serialize.
    const names = [...this.enabled];
    const metas = await Promise.all(names.map((n) => this.metadata(n).catch(() => undefined)));
    const out = new Map<string, ToolMeta[]>();
    names.forEach((n, i) => metas[i] && out.set(n, metas[i]!));
    return out;
  }

  // ---- tool calls -----------------------------------------------------------

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    if (!this.conns.has(name)) await this.connect(name);
    const client = this.conns.get(name)!.client;
    this.touch(name);
    const res = (await client.callTool({ name: tool, arguments: args }, undefined, { signal })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    this.touch(name);
    const text = (res.content ?? [])
      .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`))
      .join("\n");
    return { text: text || "(no output)", isError: !!res.isError };
  }

  // ---- status ---------------------------------------------------------------

  state(name: string): ServerState {
    if (!this.enabled.has(name)) return "off";
    if (this.conns.has(name)) return "connected";
    const fail = this.fails.get(name);
    if (fail?.kind === "needs-auth") return "needs-auth";
    if (fail) return "failed";
    return this.toolCount(name) != null ? "cached" : "idle";
  }
}
