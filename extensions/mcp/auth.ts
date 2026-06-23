/**
 * OAuth + bearer auth for HTTP MCP servers.
 *
 * A file-backed `OAuthClientProvider` persists per-server credentials (client
 * registration, tokens, PKCE verifier) under `~/.pi/agent/mcp/auth.json`, keyed
 * by server URL. The SDK's `auth()` helper drives PKCE + dynamic client
 * registration + token exchange/refresh against that provider.
 *
 * Three entry points:
 *   - `authInteractive` — TUI flow: spins a localhost callback server, opens the
 *     browser, waits for the redirect, exchanges the code.
 *   - `authStart` / `authComplete` — headless flow: returns the URL to open, then
 *     completes from the pasted redirect URL (PKCE state survives via auth.json).
 *   - `clientCredentials` grant is non-interactive (no redirect).
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
// Stable redirect for the headless flow (the page never loads — the user copies
// the address-bar URL), so it must be identical across auth-start/auth-complete.
const MANUAL_REDIRECT = "http://localhost:33418/callback";

// OAuth servers can silently expire DCR registrations.  Re-register after this
// period so stale client_ids never reach the authorization endpoint.
const CLIENT_REGISTRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

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
      // Public PKCE clients authenticate with "none"; only advertise a secret
      // method when a secret is actually in play (client_credentials / configured).
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

// ---- helpers ---------------------------------------------------------------

function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : win ? "cmd" : "xdg-open";
  const args = win ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best effort */
  }
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
    if (signal.aborted) return rej(new Error("cancelled"));
    const onAbort = () => rej(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    p.then((v) => (done(), res(v)), (e) => (done(), rej(e)));
  });
}

// ---- public API ------------------------------------------------------------

/**
 * Returns true when the stored DCR client for `serverUrl` is absent, has no
 * `registeredAt` timestamp (written by older versions), or is older than
 * CLIENT_REGISTRATION_MAX_AGE_MS.  In those cases the caller should invalidate
 * the stored client before starting a new authorization flow so that fresh DCR
 * runs and the authorization URL uses a valid client_id.
 */
function isDcrStale(serverUrl: string): boolean {
  const store = readState<Record<string, AuthRecord>>(AUTH_FILE, {});
  const rec = store[serverUrl];
  if (!rec?.client) return false; // nothing stored — DCR will run naturally
  if (!rec.registeredAt) return true; // old record with no timestamp — treat as stale
  return Date.now() - rec.registeredAt > CLIENT_REGISTRATION_MAX_AGE_MS;
}

export function bearerHeaders(def: ServerDef): Record<string, string> {
  return def.bearerToken ? { Authorization: `Bearer ${def.bearerToken}` } : {};
}

/** Provider attached to the live transport so it can refresh tokens on its own. */
export function oauthProvider(def: ServerDef): OAuthClientProvider {
  return new FileProvider(def.url!, def.oauth?.redirectUri ?? MANUAL_REDIRECT, def);
}

/** Interactive browser flow used by the `/mcp` panel (press `a`). */
export async function authInteractive(def: ServerDef, signal?: AbortSignal): Promise<void> {
  const url = def.url!;
  if (def.oauth?.grantType === "client_credentials") {
    if ((await auth(new FileProvider(url, undefined, def), { serverUrl: url })) !== "AUTHORIZED") {
      throw new Error("client_credentials grant did not complete");
    }
    return;
  }
  const cb = await startCallback(def.oauth?.redirectUri);
  try {
    const provider = new FileProvider(url, cb.redirect, def, (u) => openBrowser(u.href));
    // Pre-invalidate any stored client registration that is too old.  OAuth servers
    // (e.g. Atlassian) silently expire DCR registrations; using a stale client_id
    // causes the authorization endpoint to return 500 before the user can authorize.
    // Clearing it here forces a fresh DCR so the authorization URL always uses a
    // valid client.
    if (isDcrStale(url)) provider.invalidateCredentials("client");
    if ((await auth(provider, { serverUrl: url })) === "AUTHORIZED") return; // tokens already valid
    const code = await withAbort(cb.code, signal);
    if ((await auth(provider, { serverUrl: url, authorizationCode: code })) !== "AUTHORIZED") {
      throw new Error("token exchange did not complete");
    }
  } finally {
    cb.close();
  }
}

/** Headless flow: returns the authorization URL to open (empty if already authed). */
export async function authStart(def: ServerDef): Promise<string> {
  const url = def.url!;
  const provider = new FileProvider(url, def.oauth?.redirectUri ?? MANUAL_REDIRECT, def);
  // Same stale-client guard as authInteractive — applies to the headless flow too.
  if (isDcrStale(url)) provider.invalidateCredentials("client");
  if ((await auth(provider, { serverUrl: url })) === "AUTHORIZED") return "";
  if (!provider.authUrl) throw new Error("no authorization URL was produced");
  return provider.authUrl.href;
}

/** Headless flow: finish from the full redirect URL the user was sent to. */
export async function authComplete(def: ServerDef, redirectUrl: string): Promise<void> {
  const url = def.url!;
  const code = new URL(redirectUrl).searchParams.get("code");
  if (!code) throw new Error('redirectUrl is missing a "?code=" parameter');
  const provider = new FileProvider(url, def.oauth?.redirectUri ?? MANUAL_REDIRECT, def);
  if ((await auth(provider, { serverUrl: url, authorizationCode: code })) !== "AUTHORIZED") {
    throw new Error("token exchange did not complete");
  }
}
