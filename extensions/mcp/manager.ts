/**
 * Connection + metadata manager.
 *
 * Servers are never connected at startup. Tool metadata is served from a
 * persistent cache (`~/.pi/agent/mcp/cache.json`, keyed by server identity hash)
 * so status/list/search/describe work offline; a missing or stale cache, or an
 * actual tool call, triggers a lazy connect. Live connections idle-disconnect
 * after `IDLE_TIMEOUT_MS`.
 *
 * Implicit OAuth: when a lazy connect returns UnauthorizedError the manager
 * runs a coalesced browser flow (via authImplicit), reconnects once, and either
 * succeeds or latches the failure for that session. Subsequent automatic calls
 * on a latched server fail fast; Shift+R and Shift+A clear the latch first.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthError, authImplicit, bearerHeaders, oauthProvider } from "./auth.ts";
import { identity, readState, type ServerDef, transportKind, writeState } from "./config.ts";

export { AuthError };

export interface ToolMeta {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type ServerState = "off" | "idle" | "cached" | "connected" | "needs-auth" | "failed";

/**
 * Point-in-time snapshot of a session's enabled MCP server set.
 * Passed to a child process at launch so it inherits only what the parent had
 * enabled at that instant.
 */
export interface McpEnabledSnapshot {
  version: 1;
  servers: Array<{ name: string; identity: string }>;
}

/** Result of enabledMetadata(): tools for reachable servers + errors for auth-blocked servers. */
export interface EnabledMetadataResult {
  meta: Map<string, ToolMeta[]>;
  /** Servers whose automatic auth latched; value is the do-not-retry error message. */
  authFailed: Map<string, string>;
}

const CACHE_FILE = "cache.json";
const CACHE_TTL = 7 * 24 * 60 * 60_000;
// After a non-auth connect failure, don't re-attempt on implicit paths for a while.
const FAIL_COOLDOWN = 60_000;
// Disconnect a live connection after this much idle time (0 = keep open).
const IDLE_TIMEOUT_MS = 10 * 60_000;

type Cache = Record<string, { savedAt: number; tools: ToolMeta[] }>;
type Failure = { message: string; at: number };

const needsAuthMessage = (name: string) =>
  `"${name}" requires authentication — use /mcp (Shift+A) to authenticate. Do not retry automatically.`;

const authFailedMessage = (name: string, detail: string) =>
  `"${name}" authentication failed: ${detail} — use /mcp (Shift+A) to re-authenticate. Do not retry automatically.`;

/**
 * Preserve the caller's environment for trusted, locally configured MCPs.
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

// OAuth credentials are deliberately shared across session-local managers. Serialize
// the credential-sensitive connection establishment per URL (not the auth flow itself,
// which is coalesced separately in auth.ts).
const oauthConnectLocks = new Map<string, Promise<void>>();

async function withOAuthConnectLock<T>(url: string, work: () => Promise<T>): Promise<T> {
  const previous = oauthConnectLocks.get(url) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
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
  /** Per-session auth latch: servers whose automatic auth failed for this session. */
  private authLatched = new Map<string, string>();
  private cacheFile?: Cache;

  /**
   * Seam for testing: when set, replaces the raw per-attempt connection logic
   * (including transport creation) for a named server. The function is called
   * once per attempt; throw `UnauthorizedError` to exercise the OAuth retry
   * path, or return `ToolMeta[]` to simulate a successful connect.
   * In production this is always undefined and the real transport/client runs.
   */
  _tryConnect?: (name: string) => Promise<ToolMeta[]>;

  /**
   * Seam for testing: replaces the implicit OAuth auth function.
   * Default is `authImplicit` from auth.ts; override in tests to control
   * whether auth succeeds or fails without opening a browser.
   */
  _authImplicit: typeof authImplicit = authImplicit;

  /**
   * Reset this session-local manager for a new extension session.
   *
   * If `snapshot` is provided and valid, seed the enabled set from it: only
   * entries whose name exists in `servers` AND whose identity matches are enabled.
   * Unknown names, identity mismatches, unsupported versions, and duplicate entries
   * are silently ignored. The snapshot is a point-in-time copy; later mutations
   * to this manager do not affect any snapshot or the parent's manager.
   */
  async initialize(servers: Map<string, ServerDef>, snapshot?: McpEnabledSnapshot): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    await this.shutdown();
    this.servers = servers;
    this.enabled.clear();
    this.meta.clear();
    this.fails.clear();
    this.authLatched.clear();
    this.cacheFile = undefined;
    this.connecting.clear();

    if (snapshot && snapshot.version === 1) {
      const seen = new Set<string>();
      for (const entry of snapshot.servers) {
        if (seen.has(entry.name)) continue; // duplicate
        seen.add(entry.name);
        const def = this.servers.get(entry.name);
        if (!def) continue; // unknown in this session's config
        if (identity(def) !== entry.identity) continue; // identity mismatch
        this.enabled.add(entry.name);
      }
    }
  }

  /**
   * Capture a fresh snapshot of the current enabled set. The returned value is
   * a plain serializable object; mutations to this manager after the call do not
   * affect the snapshot, and vice versa.
   */
  snapshot(): McpEnabledSnapshot {
    const servers: Array<{ name: string; identity: string }> = [];
    for (const name of this.enabled) {
      const def = this.servers.get(name);
      if (def) servers.push({ name, identity: identity(def) });
    }
    return { version: 1, servers };
  }

  /** Clear the per-session auth latch before a manual retry. */
  clearAuthLatch(name: string): void {
    this.authLatched.delete(name);
  }

  /** Return enabled servers whose automatic auth failed for this session. */
  getAuthFailures(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, msg] of this.authLatched) {
      if (this.enabled.has(name)) out.set(name, msg);
    }
    return out;
  }

  list(): string[] {
    return [...this.servers.keys()].sort();
  }

  // ---- cache ----------------------------------------------------------------

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

  /**
   * Connect to `name`, running implicit OAuth if needed.
   *
   * An optional `signal` from the caller (e.g. a tool's abort signal) is
   * composed with the 120-second auth deadline inside `authImplicit`. Metadata
   * and search paths omit the signal; only actual tool calls pass one.
   */
  async connect(name: string, signal?: AbortSignal): Promise<ToolMeta[]> {
    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const attempt = this._connectWithAuth(name, signal).finally(() => this.connecting.delete(name));
    this.connecting.set(name, attempt);
    return attempt;
  }

  private async _connectWithAuth(name: string, signal?: AbortSignal): Promise<ToolMeta[]> {
    const def = this.servers.get(name);
    if (!def) throw new Error(`unknown server "${name}"`);
    const kind = transportKind(def);
    if (kind === "invalid") throw new Error(`server "${name}" has neither "command" nor "url"`);

    const isOAuth = kind === "http" && def.auth === "oauth";

    // Core connection attempt (serialized per URL for OAuth servers).
    const innerTryConnect = (): Promise<ToolMeta[]> => {
      const establish = async (): Promise<ToolMeta[]> => {
        await this.disconnect(name);
        const client = new Client({ name: "pi-mcp", version: "1.0.0" });
        const transport = this.transport(def, kind);
        const conn: Conn = { client };
        transport.onclose = () => {
          if (this.conns.get(name) === conn) void this.disconnect(name, conn);
        };
        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          const meta = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
          this.fails.delete(name);
          this.authLatched.delete(name);
          this.meta.set(name, meta);
          this.saveCache(def, meta);
          this.conns.set(name, conn);
          this.touch(name);
          return meta;
        } catch (e) {
          await client.close().catch(() => {});
          throw e; // re-throw for caller to classify
        }
      };
      return isOAuth ? withOAuthConnectLock(def.url!, establish) : establish();
    }; // end innerTryConnect

    const tryConnect = (): Promise<ToolMeta[]> =>
      this._tryConnect ? this._tryConnect(name) : innerTryConnect();

    // First connection attempt.
    let firstError: unknown;
    try {
      return await tryConnect();
    } catch (e) {
      firstError = e;
    }

    if (!(firstError instanceof UnauthorizedError)) {
      // Non-auth connection error.
      const message = `"${name}" failed to connect: ${firstError instanceof Error ? firstError.message : String(firstError)}`;
      this.fails.set(name, { message, at: Date.now() });
      throw new Error(message);
    }

    // ---- Implicit OAuth flow -----------------------------------------------

    // Fail fast if a prior automatic auth already latched for this session.
    const latched = this.authLatched.get(name);
    if (latched) throw new AuthError(latched, name);

    // Run the coalesced browser flow.
    try {
      await this._authImplicit(def, { signal });
    } catch (authErr) {
      const detail = authErr instanceof Error ? authErr.message : String(authErr);
      const message = authErr instanceof AuthError ? authErr.message : authFailedMessage(name, detail);
      this.authLatched.set(name, message);
      throw new AuthError(message, name);
    }

    // One reconnect after successful auth.
    try {
      return await tryConnect();
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        // Still unauthorized after auth — latch immediately.
        const message = needsAuthMessage(name);
        this.authLatched.set(name, message);
        throw new AuthError(message, name);
      }
      const message = `"${name}" failed to connect after authentication: ${e instanceof Error ? e.message : String(e)}`;
      this.fails.set(name, { message, at: Date.now() });
      throw new Error(message);
    }
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

  // ---- metadata (cache-first, lazy connect) --------------------------------

  /**
   * Metadata for `name`. Serves from cache when available. A missing or stale
   * cache triggers a lazy connect; `signal` is forwarded to `connect` so it
   * can be composed with the auth deadline if auth is needed.
   */
  async metadata(name: string, signal?: AbortSignal): Promise<ToolMeta[]> {
    const known = this.meta.get(name);
    if (known) return known;
    const def = this.servers.get(name);
    if (!def) throw new Error(`unknown server "${name}"`);

    // Fail fast if auth is latched.
    const latched = this.authLatched.get(name);
    if (latched) throw new AuthError(latched, name);

    const cached = this.cached(def);
    if (cached) {
      this.meta.set(name, cached);
      return cached;
    }
    // Respect the ordinary failure cooldown on this implicit path.
    const fail = this.fails.get(name);
    if (fail && Date.now() - fail.at < FAIL_COOLDOWN) {
      throw new Error(fail.message);
    }
    return this.connect(name, signal);
  }

  /**
   * Metadata for every enabled server.
   *
   * Reachable servers land in `meta`. Servers that fail due to a latched auth
   * error land in `authFailed` with their do-not-retry message. Other failures
   * are silently skipped (best-effort for search/list use cases).
   */
  async enabledMetadata(): Promise<EnabledMetadataResult> {
    const names = [...this.enabled];
    const results = await Promise.all(
      names.map((n) =>
        this.metadata(n).then(
          (tools) => ({ ok: true as const, tools }),
          (err) => ({ ok: false as const, err }),
        ),
      ),
    );
    const meta = new Map<string, ToolMeta[]>();
    const authFailed = new Map<string, string>();
    names.forEach((n, i) => {
      const r = results[i];
      if (r.ok) {
        meta.set(n, r.tools);
      } else if (r.err instanceof AuthError) {
        authFailed.set(n, r.err.message);
      }
      // Other failures silently skipped.
    });
    return { meta, authFailed };
  }

  // ---- tool calls ----------------------------------------------------------

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    // Fail fast for latched auth before attempting a reconnect.
    const latched = this.authLatched.get(name);
    if (latched && !this.conns.has(name)) throw new AuthError(latched, name);

    if (!this.conns.has(name)) await this.connect(name, signal);
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

  // ---- status --------------------------------------------------------------

  state(name: string): ServerState {
    if (!this.enabled.has(name)) return "off";
    if (this.conns.has(name)) return "connected";
    if (this.authLatched.has(name)) return "needs-auth";
    const fail = this.fails.get(name);
    if (fail) return "failed";
    return this.toolCount(name) != null ? "cached" : "idle";
  }
}
