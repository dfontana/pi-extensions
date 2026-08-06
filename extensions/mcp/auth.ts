/**
 * OAuth + bearer auth for HTTP MCP servers.
 *
 * A file-backed `OAuthClientProvider` persists per-server credentials (client
 * registration, tokens, PKCE verifier) under `~/.pi/agent/mcp/auth.json`, keyed
 * by server URL. The SDK's `auth()` helper drives PKCE + dynamic client
 * registration + token exchange/refresh against that provider.
 *
 * Two entry points for callers:
 *   - `authImplicit` — coalesced implicit flow used by the manager when a lazy
 *     connect returns UnauthorizedError. Opens a browser only once per URL even
 *     with concurrent callers; respects a 120-second end-to-end deadline.
 *   - `authInteractive` — explicit re-auth flow for the /mcp panel (Shift+A).
 *     Always bypasses the coalescing cache so the user gets a fresh flow.
 *   - `clientCredentials` grant is non-interactive (no redirect) in both paths.
 *
 * Both functions throw `AuthError` on failure with a named-server, do-not-retry
 * message. The manager latches that error per session; subsequent automatic
 * calls fail fast without opening another browser.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { readState, type ServerDef, writeState } from "./config.ts";

const AUTH_FILE = "auth.json";

/** End-to-end deadline for a complete auth operation (discovery → browser → callback → token). */
export const AUTH_DEADLINE_MS = 120_000;

// OAuth servers can silently expire DCR registrations.  Re-register after this
// period so stale client_ids never reach the authorization endpoint.
const CLIENT_REGISTRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

// ---- AuthError -------------------------------------------------------------

/**
 * Thrown when MCP OAuth authentication fails, times out, or is cancelled.
 * The message names the server and tells the agent not to retry automatically.
 * The manager latches this error per session.
 */
export class AuthError extends Error {
  readonly serverName: string;
  /** Marks this as an explicit do-not-retry auth failure. */
  readonly isAuthError = true as const;

  constructor(message: string, serverName: string) {
    super(message);
    this.name = "AuthError";
    this.serverName = serverName;
  }
}

// ---- Storage ---------------------------------------------------------------

interface AuthRecord {
  client?: OAuthClientInformationFull;
  /** Unix-ms timestamp recorded when the DCR response was saved. */
  registeredAt?: number;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}
type AuthStore = Record<string, AuthRecord>;

class FileProvider implements OAuthClientProvider {
  authUrl?: URL;

  constructor(
    private key: string,
    readonly redirectUrl: string | undefined,
    private def: ServerDef,
    private onRedirect?: (url: URL) => void,
  ) {}

  private read(): AuthRecord {
    return readState<AuthStore>(AUTH_FILE, {})[this.key] ?? {};
  }
  private write(patch: Partial<AuthRecord>): void {
    const store = readState<AuthStore>(AUTH_FILE, {});
    store[this.key] = { ...store[this.key], ...patch };
    writeState(AUTH_FILE, store);
  }

  get clientMetadata(): OAuthClientMetadata {
    const cc = this.def.oauth?.grantType === "client_credentials";
    const confidential = cc || !!this.def.oauth?.clientSecret;
    return {
      client_name: "pi-mcp",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: cc ? ["client_credentials"] : ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
      scope: this.def.oauth?.scope,
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = this.read().client;
    if (stored) return stored;
    if (this.def.oauth?.clientId) {
      return { client_id: this.def.oauth.clientId, client_secret: this.def.oauth.clientSecret };
    }
    return undefined;
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.write({ client: info, registeredAt: Date.now() });
  }
  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }
  saveCodeVerifier(v: string): void {
    this.write({ codeVerifier: v });
  }
  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error("missing PKCE code verifier — restart authentication");
    return v;
  }
  redirectToAuthorization(url: URL): void {
    this.authUrl = url;
    this.onRedirect?.(url);
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const store = readState<AuthStore>(AUTH_FILE, {});
    const rec = store[this.key];
    if (!rec) return;
    if (scope === "all") delete store[this.key];
    else if (scope === "tokens") delete rec.tokens;
    else if (scope === "client") delete rec.client;
    else if (scope === "verifier") delete rec.codeVerifier;
    writeState(AUTH_FILE, store);
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Spawn the platform browser launcher and resolve when it exits successfully.
 * Rejects if the launcher cannot be spawned or exits nonzero.
 */
async function openBrowser(url: string): Promise<void> {
  const win = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : win ? "cmd" : "xdg-open";
  const args = win ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch (e) {
      return reject(new Error(`Cannot spawn browser launcher "${cmd}": ${(e as Error).message}`));
    }
    child.once("error", (e) => reject(new Error(`Browser launcher "${cmd}" failed: ${e.message}`)));
    child.once("close", (code) => {
      child.unref();
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Browser launcher "${cmd}" exited with code ${code}`));
    });
  });
}

const RESULT_PAGE = (ok: boolean, detail: string) =>
  `<!doctype html><meta charset=utf-8><title>pi-mcp</title>` +
  `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b0b0f;color:#e6e6e6">` +
  `<div style="text-align:center"><h2>${ok ? "Authorized ✓" : "Authorization failed"}</h2>` +
  `<p style="color:#9a9aa6">${detail}</p></div>`;

/** Localhost callback server that resolves with the `code` from the redirect. */
async function startCallback(redirectUri?: string): Promise<{
  redirect: string;
  code: Promise<string>;
  close: () => void;
}> {
  const target = redirectUri ? new URL(redirectUri) : undefined;
  const path = target?.pathname || "/callback";
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (!u.pathname.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }
    const c = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(RESULT_PAGE(!!c, c ? "You can close this tab and return to pi." : (err ?? "no code returned")));
    if (c) resolveCode(c);
    else rejectCode(new Error(err ?? "authorization failed"));
  });
  await new Promise<void>((res) => server.listen(target ? Number(target.port) || 0 : 0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  return {
    redirect: redirectUri ?? `http://localhost:${port}${path}`,
    code,
    close: () => server.close(),
  };
}

function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((res, rej) => {
    // Always attach fulfillment/rejection handlers to p so its eventual
    // settlement is observed regardless of which side wins the race.
    // This prevents unhandled-rejection noise after cancellation.
    if (signal.aborted) {
      p.then(undefined, () => { /* observed; signal already won */ });
      return rej(new Error("cancelled"));
    }
    const onAbort = () => rej(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); res(v); },
      (e) => { signal.removeEventListener("abort", onAbort); rej(e); },
    );
  });
}

// ---- DCR staleness ---------------------------------------------------------

/**
 * Returns true when the stored DCR client for `serverUrl` is absent (no-op),
 * lacks a `registeredAt` timestamp (old record), or is older than
 * CLIENT_REGISTRATION_MAX_AGE_MS. Callers should invalidate the stored client
 * before starting a new authorization flow so fresh DCR runs.
 */
function isDcrStale(serverUrl: string): boolean {
  const store = readState<Record<string, AuthRecord>>(AUTH_FILE, {});
  const rec = store[serverUrl];
  if (!rec?.client) return false;
  if (!rec.registeredAt) return true;
  return Date.now() - rec.registeredAt > CLIENT_REGISTRATION_MAX_AGE_MS;
}

// ---- Coalesced auth flows --------------------------------------------------

/**
 * One active auth flow per server URL. Concurrent callers wait for the same
 * flow rather than each opening a browser. If the flow succeeds, waiters
 * return normally (and the caller re-attempts the connection). If it fails,
 * waiters receive the same error and each latch their own session independently.
 */
const activeAuthFlows = new Map<string, Promise<void>>();

// ---- Core auth flow --------------------------------------------------------

/** Options accepted by both authImplicit and authInteractive. */
export interface AuthFlowOptions {
  signal?: AbortSignal;
  /** End-to-end deadline in ms. Default: AUTH_DEADLINE_MS (120 s). */
  deadlineMs?: number;
  /**
   * Injectable browser launcher for testing. Production code uses the
   * platform opener (open / xdg-open / start).
   */
  openBrowserFn?: (url: string) => Promise<void>;
}

/**
 * Execute one complete OAuth flow for `def`.
 *
 * For `client_credentials` grants: calls the token endpoint directly (no
 * browser). For `authorization_code` grants: starts a localhost callback,
 * opens the browser, awaits the redirect, and exchanges the code.
 *
 * The entire flow is bounded by `deadlineMs` (default 120 s), composed with
 * any caller `signal`. Every code path (success, failure, timeout, browser
 * error, cancellation) closes the callback server. Throws `AuthError` on any
 * failure with a named-server do-not-retry message.
 */
async function runOAuthFlow(def: ServerDef, options: AuthFlowOptions): Promise<void> {
  const { signal, deadlineMs = AUTH_DEADLINE_MS, openBrowserFn = openBrowser } = options;
  const url = def.url!;

  // Compose deadline with caller signal.
  const deadline = AbortSignal.timeout(deadlineMs);
  const composed: AbortSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;

  const authErr = (detail: string): AuthError =>
    new AuthError(
      `"${def.name}" ${detail} — use /mcp (Shift+A) to re-authenticate. Do not retry automatically.`,
      def.name,
    );

  // Abort-aware fetch wrapper: threads the composed deadline+caller signal
  // into every SDK discovery/token HTTP request so they cancel promptly on
  // timeout or cancellation rather than running until the network gives up.
  const abortFetch: typeof fetch = (input, init) => {
    const sig = init?.signal
      ? AbortSignal.any([composed, init.signal as AbortSignal])
      : composed;
    return fetch(input, { ...init, signal: sig });
  };

  const guard = async <T>(step: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (composed.aborted) throw authErr("authentication timed out or was cancelled");
      throw authErr(`${step}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- client_credentials (browserless) ------------------------------------
  if (def.oauth?.grantType === "client_credentials") {
    if (composed.aborted) throw authErr("authentication timed out or was cancelled");
    const provider = new FileProvider(url, undefined, def);
    const result = await guard("authentication failed", () => auth(provider, { serverUrl: url, fetchFn: abortFetch }));
    if (result !== "AUTHORIZED") throw authErr("client_credentials grant did not complete");
    return;
  }

  // ---- authorization_code (browser flow) ------------------------------------
  if (composed.aborted) throw authErr("authentication timed out or was cancelled");
  const cb = await startCallback(def.oauth?.redirectUri);
  try {
    const provider = new FileProvider(url, cb.redirect, def);

    // For dynamic-port callbacks, any stored DCR client is tied to a stale
    // redirect URI — always re-register to get a valid client for the new port.
    // For configured stable URIs, only re-register when the age threshold passes.
    if (!def.oauth?.redirectUri || isDcrStale(url)) {
      provider.invalidateCredentials("client");
    }

    // First call: returns AUTHORIZED if stored credentials are valid/refreshable.
    // Otherwise triggers redirectToAuthorization → sets provider.authUrl.
    const firstResult = await guard("authentication failed", () => auth(provider, { serverUrl: url, fetchFn: abortFetch }));
    if (firstResult === "AUTHORIZED") return; // existing credentials are valid

    // Open the browser for the authorization URL.
    if (!provider.authUrl) throw authErr("no authorization URL was produced");
    await guard("browser launch failed", () => withAbort(openBrowserFn(provider.authUrl!.href), composed));

    // Wait for the browser callback with the authorization code.
    const code = await guard("authorization callback failed", () => withAbort(cb.code, composed));

    // Exchange the code for tokens.
    const finalResult = await guard("token exchange failed", () =>
      auth(provider, { serverUrl: url, authorizationCode: code, fetchFn: abortFetch }),
    );
    if (finalResult !== "AUTHORIZED") throw authErr("token exchange did not complete");
  } finally {
    cb.close();
  }
}

// ---- Public API ------------------------------------------------------------

export function bearerHeaders(def: ServerDef): Record<string, string> {
  return def.bearerToken ? { Authorization: `Bearer ${def.bearerToken}` } : {};
}

/** Provider attached to the live transport so it can refresh tokens on its own. */
export function oauthProvider(def: ServerDef): OAuthClientProvider {
  const redirectUrl =
    def.oauth?.grantType === "client_credentials"
      ? undefined
      : def.oauth?.redirectUri ??
        readState<AuthStore>(AUTH_FILE, {})[def.url!]?.client?.redirect_uris?.[0] ??
        "http://localhost/";
  return new FileProvider(def.url!, redirectUrl, def);
}

/**
 * Forget all locally persisted OAuth state for this server. The next
 * authorization attempt obtains fresh credentials rather than refreshing.
 */
export function clearOAuthCredentials(def: ServerDef): void {
  if (!def.url) return;
  new FileProvider(def.url, def.oauth?.redirectUri, def).invalidateCredentials("all");
}

/**
 * Coalesced implicit auth: open one browser flow per server URL even when
 * multiple concurrent callers need auth at the same time. A waiter that sees
 * an in-progress flow awaits it and returns normally on success (the caller
 * retries the connection). On failure all waiters receive the same error and
 * each latch their own session independently.
 *
 * Called by the manager when `connect` encounters `UnauthorizedError`.
 */
export async function authImplicit(def: ServerDef, options?: AuthFlowOptions): Promise<void> {
  const url = def.url!;
  const existing = activeAuthFlows.get(url);
  if (existing) {
    // Waiter: block until the first caller's flow resolves or rejects.
    await existing;
    // If we reach here the flow succeeded and credentials are now written.
    // The caller will retry the connection; let it proceed.
    return;
  }

  const flow = runOAuthFlow(def, options ?? {}).finally(() => {
    if (activeAuthFlows.get(url) === flow) activeAuthFlows.delete(url);
  });
  activeAuthFlows.set(url, flow);
  await flow;
}

/**
 * Explicit interactive re-auth flow for the /mcp panel (Shift+A). Always
 * bypasses the coalescing cache so the user gets a guaranteed fresh flow
 * regardless of any in-progress implicit attempt.
 */
export async function authInteractive(def: ServerDef, options?: AuthFlowOptions): Promise<void> {
  return runOAuthFlow(def, options ?? {});
}
