import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auth as sdkAuth } from "@modelcontextprotocol/client";
import { describe, it } from "node:test";
import type { AuthRecord, AuthStorage } from "./auth-storage.ts";

// config.ts resolves the agent directory while it loads, so this must be set
// before dynamically importing the OAuth module under test.
const agentDir = mkdtempSync(join(tmpdir(), "mcp-auth-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const oauth = await import("./auth.ts");
const { AuthError } = oauth;
const { FileAuthStorage } = await import("./auth-storage.ts");
// Compatibility tests explicitly opt into plaintext storage; never use real Keychain.
const fileStorage = new FileAuthStorage();
const clearOAuthCredentials: typeof oauth.clearOAuthCredentials = (def, storage = fileStorage) => oauth.clearOAuthCredentials(def, storage);
const oauthProvider: typeof oauth.oauthProvider = (def, storage = fileStorage) => oauth.oauthProvider(def, storage);
const authImplicit: typeof oauth.authImplicit = (def, options) => oauth.authImplicit(def, { storage: fileStorage, ...options });
const authInteractive: typeof oauth.authInteractive = (def, options) => oauth.authInteractive(def, { storage: fileStorage, ...options });

const authFile = join(agentDir, "mcp", "auth.json");

function writeAuthState(state: unknown): void {
  mkdirSync(dirname(authFile), { recursive: true });
  writeFileSync(authFile, JSON.stringify(state));
}

function readAuthState(): unknown {
  return JSON.parse(readFileSync(authFile, "utf8"));
}

class MemoryAuthStorage implements AuthStorage {
  readonly records = new Map<string, AuthRecord>();

  async read(serverUrl: string): Promise<AuthRecord | undefined> {
    return this.records.get(serverUrl);
  }

  async update(
    serverUrl: string,
    transform: (current: AuthRecord | undefined) => AuthRecord | undefined,
  ): Promise<void> {
    const current = this.records.get(serverUrl);
    const next = transform(current);
    if (next === current) return;
    if (next === undefined) this.records.delete(serverUrl);
    else this.records.set(serverUrl, next);
  }
}

describe("mcp auth", () => {
  it("clears every saved OAuth field for only the selected server", async () => {
    const url = "https://reauth.example.test/mcp";
    const otherUrl = "https://other.example.test/mcp";
    const other = { tokens: { access_token: "keep" } };
    writeAuthState({
      [url]: {
        client: { client_id: "old-client", client_secret: "old-secret" },
        registeredAt: 1,
        tokens: { access_token: "old-access", refresh_token: "old-refresh" },
        codeVerifier: "old-verifier",
      },
      [otherUrl]: other,
    });

    await clearOAuthCredentials({ name: "reauth", url, auth: "oauth" });

    assert.deepEqual(readAuthState(), { [otherUrl]: other });
  });

  it("provider and credential helpers use the injected asynchronous storage", async () => {
    const url = "https://in-memory.example.test/mcp";
    const otherUrl = "https://other-in-memory.example.test/mcp";
    const diskState = { "https://file-only.example.test/mcp": { tokens: { access_token: "file-token" } } };
    writeAuthState(diskState);

    const storage = new MemoryAuthStorage();
    const record: AuthRecord = {
      client: { client_id: "memory-client", redirect_uris: ["http://localhost:1234/callback"], issuer: url },
      registeredAt: Date.now(),
      tokens: { access_token: "memory-access", token_type: "bearer", issuer: url },
    };
    storage.records.set(url, record);
    storage.records.set(otherUrl, { tokens: { access_token: "other-access", token_type: "bearer" } });

    const provider = await oauthProvider({ name: "memory", url, auth: "oauth" }, storage);
    assert.equal(provider.redirectUrl, "http://localhost:1234/callback");
    assert.equal((await provider.clientInformation({ issuer: url }))?.client_id, "memory-client");
    assert.equal((await provider.tokens({ issuer: url }))?.access_token, "memory-access");

    await provider.saveClientInformation?.({ client_id: "replacement-client", issuer: url });
    assert.equal(storage.records.get(url)?.client?.client_id, "replacement-client");
    await provider.saveTokens({ access_token: "replacement-access", token_type: "bearer", issuer: url });
    assert.equal(storage.records.get(url)?.tokens?.access_token, "replacement-access");
    await provider.invalidateCredentials?.("tokens");
    assert.equal(storage.records.get(url)?.tokens, undefined);
    assert.equal(storage.records.get(url)?.client?.client_id, "replacement-client");

    await clearOAuthCredentials({ name: "memory", url, auth: "oauth" }, storage);
    assert.equal(storage.records.has(url), false);
    assert.equal(storage.records.get(otherUrl)?.tokens?.access_token, "other-access");
    assert.deepEqual(readAuthState(), diskState, "injected storage helpers must not read or write auth.json");
  });

  it("registration-age checks read and invalidate credentials through injected storage", async () => {
    const diskState = { "https://file-only.example.test/mcp": { tokens: { access_token: "file-token" } } };
    writeAuthState(diskState);
    const cases = [
      { label: "fresh", registeredAt: Date.now(), expectedRegistrations: 0, expectedClient: "saved-client" },
      { label: "stale", registeredAt: 1, expectedRegistrations: 1, expectedClient: "test-client" },
    ];

    for (const test of cases) {
      let registrationCount = 0;
      const { server, port } = await startMockOAuthServer({ onDcr: () => registrationCount++ });
      const url = `http://localhost:${port}`;
      const redirectUri = "http://localhost:4321/callback";
      const storage = new MemoryAuthStorage();
      storage.records.set(url, {
        client: { client_id: "saved-client", redirect_uris: [redirectUri], issuer: url },
        registeredAt: test.registeredAt,
      });
      try {
        await assert.rejects(
          () => authInteractive(
            { name: `age-${test.label}`, url, auth: "oauth", oauth: { redirectUri } },
            { storage, deadlineMs: 5_000, openBrowserFn: async () => { throw new Error("stop after authorization URL"); } },
          ),
          (error) => error instanceof AuthError && /browser launch failed/.test(error.message),
        );
        assert.equal(registrationCount, test.expectedRegistrations, test.label);
        assert.equal(storage.records.get(url)?.client?.client_id, test.expectedClient, test.label);
      } finally {
        server.close();
      }
    }

    assert.deepEqual(readAuthState(), diskState, "auth flow storage injection must not fall back to auth.json");
  });

  it("AuthError carries server name and isAuthError flag", () => {
    const err = new AuthError("test message — Do not retry automatically.", "my-server");
    assert.equal(err.serverName, "my-server");
    assert.equal(err.isAuthError, true);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AuthError");
  });

  it("refreshes saved OAuth tokens without starting browser authorization", async () => {
    let requestCount = 0;
    let refreshGrantCount = 0;
    let browserAuthorizationCount = 0;
    const { server, port } = await startMockOAuthServer({
      onRequest: () => requestCount++,
      tokenHandler: (params) => {
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), "saved-refresh");
        refreshGrantCount++;
        return { access_token: "replacement-access", token_type: "bearer", refresh_token: "replacement-refresh" };
      },
    });
    const url = `http://localhost:${port}`;
    const redirectUri = "http://localhost:4321/callback";
    writeAuthState({
      [url]: {
        client: { client_id: "saved-client", redirect_uris: [redirectUri] },
        tokens: { access_token: "old-access", refresh_token: "saved-refresh", token_type: "bearer" },
      },
    });

    try {
      const def = { name: "refresh-server", url, auth: "oauth" as const };
      const provider = await oauthProvider(def);
      assert.equal(requestCount, 0, "constructing the provider must not make a request");
      assert.equal(provider.redirectUrl, redirectUri);
      provider.redirectToAuthorization = () => { browserAuthorizationCount++; };

      assert.equal(await sdkAuth(provider, { serverUrl: url }), "AUTHORIZED");
      assert.equal(refreshGrantCount, 1);
      assert.equal(browserAuthorizationCount, 0);
      const fileState = readAuthState() as Record<string, {
        client: { issuer?: string };
        tokens: { access_token: string; issuer?: string };
      }>;
      assert.deepEqual(Object.keys(fileState), [url], "auth.json remains keyed directly by server URL");
      const saved = fileState[url];
      assert.deepEqual(
        Object.keys(saved).sort(),
        ["client", "discoveryState", "tokens"],
        "auth.json entries retain the SDK v2 record shape",
      );
      assert.equal(saved.tokens.access_token, "replacement-access");
      assert.equal(saved.tokens.issuer, url);
      assert.equal(saved.client.issuer, url);
    } finally {
      server.close();
    }
  });

  it("does not return OAuth credentials bound to a different issuer", async () => {
    const url = "https://issuer-bound.example.test/mcp";
    const issuer = "https://auth.example.test";
    writeAuthState({
      [url]: {
        client: { client_id: "bound-client", issuer },
        tokens: { access_token: "bound-token", issuer },
      },
    });
    const provider = await oauthProvider({ name: "issuer-bound", url, auth: "oauth" });

    assert.equal(await provider.clientInformation({ issuer: "https://other-auth.example.test" }), undefined);
    assert.equal(await provider.tokens({ issuer: "https://other-auth.example.test" }), undefined);
    assert.equal((await provider.tokens())?.access_token, "bound-token");
  });

  it("completes browser OAuth and persists issuer-stamped credentials", async () => {
    let codeGrantCount = 0;
    const { server, port } = await startMockOAuthServer({
      clientId: "browser-client",
      issuerResponse: true,
      tokenHandler: (params) => {
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("code"), "browser-code");
        codeGrantCount++;
        return { access_token: "browser-access", refresh_token: "browser-refresh", token_type: "bearer" };
      },
    });
    const url = `http://localhost:${port}`;
    let browserOpenCount = 0;
    let submitWrongState = true;
    const openBrowserFn = async (authorizationUrl: string): Promise<void> => {
      browserOpenCount++;
      const authorization = new URL(authorizationUrl);
      const redirect = authorization.searchParams.get("redirect_uri");
      assert.ok(redirect, "authorization URL includes the callback URI");
      const callback = new URL(redirect);
      callback.hostname = "127.0.0.1";
      callback.searchParams.set("code", "browser-code");
      callback.searchParams.set("iss", url);
      const state = authorization.searchParams.get("state");
      assert.ok(state, "authorization URL includes a CSRF state");
      callback.searchParams.set("state", submitWrongState ? "wrong-state" : state);
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    };

    try {
      const def = { name: "browser-server", url, auth: "oauth" as const };
      await assert.rejects(
        () => authInteractive(def, { openBrowserFn, deadlineMs: 5_000 }),
        (error) => error instanceof AuthError && /callback state did not match/.test(error.message),
      );
      assert.equal(codeGrantCount, 0, "a mismatched state must not exchange the authorization code");
      submitWrongState = false;
      await authInteractive(def, { openBrowserFn, deadlineMs: 5_000 });
      assert.equal(browserOpenCount, 2);
      assert.equal(codeGrantCount, 1);
      const saved = (readAuthState() as Record<string, { client?: { issuer?: string }; tokens?: { access_token: string; issuer?: string } }>)[url];
      assert.equal(saved.tokens?.access_token, "browser-access");
      assert.equal(saved.tokens?.issuer, url);
      assert.equal(saved.client?.issuer, url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("auth flow failures preserve names, retry guidance, and browser boundaries", async () => {
    const cases: Array<{
      label: string;
      name: string;
      flow: "implicit" | "interactive";
      signal?: AbortSignal;
      deadlineMs?: number;
      grantType?: "client_credentials";
      mockDelayMs?: number;
      expected: RegExp;
      browserCount: number;
    }> = [
      { label: "implicit abort", name: "abort-test", flow: "implicit", signal: AbortSignal.abort(), expected: /timed out|cancelled/i, browserCount: 0 },
      { label: "interactive abort", name: "interactive-abort", flow: "interactive", signal: AbortSignal.abort(), expected: /timed out|cancelled/i, browserCount: 0 },
      { label: "tiny timeout", name: "timeout-server", flow: "implicit", deadlineMs: 1, mockDelayMs: 50, expected: /timed out|cancelled/i, browserCount: 0 },
      { label: "browser launch", name: "browser-fail-server", flow: "implicit", mockDelayMs: 0, expected: /browser launch failed/i, browserCount: 1 },
      { label: "client credentials abort", name: "cc-abort-server", flow: "implicit", grantType: "client_credentials", signal: AbortSignal.abort(), expected: /timed out|cancelled/i, browserCount: 0 },
    ];

    for (const test of cases) {
      const mock = test.mockDelayMs !== undefined ? await startMockOAuthServer({ responseDelayMs: test.mockDelayMs }) : undefined;
      const url = mock ? `http://localhost:${mock.port}` : `https://${test.name}.example.test/mcp`;
      const def = {
        name: test.name,
        url,
        auth: "oauth" as const,
        ...(test.grantType ? { oauth: { grantType: test.grantType } } : {}),
      };
      let browserCount = 0;
      const openBrowserFn = async (_url: string): Promise<void> => {
        browserCount++;
        if (test.label === "browser launch") throw new Error("No display server available");
      };
      const run = test.flow === "implicit" ? authImplicit : authInteractive;
      try {
        await assert.rejects(
          () => run(def, { signal: test.signal, deadlineMs: test.deadlineMs ?? 5_000, openBrowserFn }),
          (err) => {
            assert.ok(err instanceof AuthError, `${test.label}: expected AuthError`);
            assert.equal(err.serverName, test.name);
            assert.match(err.message, test.expected);
            assert.match(err.message, /Do not retry automatically/);
            return true;
          },
        );
        assert.equal(browserCount, test.browserCount, `${test.label}: browser launch count`);
      } finally {
        mock?.server.close();
      }
    }
  });
  for (const test of [
    { name: "concurrent authImplicit calls coalesce to one browser flow", run: authImplicit, shared: true, browserCount: 1 },
    { name: "keeps implicit auth flows isolated across different storage backends", run: authImplicit, shared: false, browserCount: 2 },
    { name: "authInteractive does not coalesce — each call runs its own flow", run: authInteractive, shared: true, browserCount: 2 },
  ]) {
    it(test.name, async () => {
      let dcrCount = 0;
      const { server, port } = await startMockOAuthServer({ onDcr: () => dcrCount++ });
      const def = { name: "concurrent-server", url: `http://localhost:${port}`, auth: "oauth" as const };
      const storage = test.shared ? fileStorage : new MemoryAuthStorage();
      let browserOpenCount = 0;
      const openBrowserFn = async (): Promise<void> => {
        browserOpenCount++;
        throw new Error("Simulated display failure");
      };

      try {
        const results = await Promise.allSettled([
          test.run(def, { storage, openBrowserFn, deadlineMs: 10_000 }),
          test.run(def, { storage: test.shared ? storage : new MemoryAuthStorage(), openBrowserFn, deadlineMs: 10_000 }),
        ]);
        for (const result of results) {
          assert.equal(result.status, "rejected");
          if (result.status === "rejected") {
            assert.ok(result.reason instanceof AuthError);
            assert.match(result.reason.message, /browser launch failed/);
          }
        }
        assert.equal(browserOpenCount, test.browserCount);
        if (test.run === authImplicit && test.shared) {
          assert.ok(dcrCount <= 1, `DCR called ${dcrCount} times; expected at most 1`);
        }
      } finally {
        server.close();
      }
    });
  }

});

// ---- Mock OAuth server helper --------------------------------------------

/**
 * Minimal OAuth 2.0 authorization server mock. Responds to:
 *   GET  /.well-known/oauth-authorization-server — server metadata
 *   POST /register — dynamic client registration
 *   POST /token — optional token exchange
 * Enough for the MCP SDK auth() to complete discovery + DCR and call
 * redirectToAuthorization, which triggers the injected openBrowserFn.
 */
async function startMockOAuthServer(
  { onDcr, onRequest, responseDelayMs = 0, clientId = "test-client", issuerResponse = false, tokenHandler }: {
    onDcr?: () => void;
    onRequest?: () => void;
    responseDelayMs?: number;
    clientId?: string;
    issuerResponse?: boolean;
    tokenHandler?: (params: URLSearchParams) => Record<string, string>;
  } = {},
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((req, res) => {
    onRequest?.();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      const respond = () => {
        const port = (server.address() as { port: number }).port;
        const base = `http://localhost:${port}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: issuerResponse,
          }),
        );
      };
      if (responseDelayMs) setTimeout(respond, responseDelayMs);
      else respond();
      return;
    }
    if (req.method === "POST" && path === "/register") {
      onDcr?.();
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            client_id: clientId,
            redirect_uris: (parsed.redirect_uris as string[]) ?? [],
            grant_types: (parsed.grant_types as string[]) ?? ["authorization_code"],
            response_types: (parsed.response_types as string[]) ?? ["code"],
            token_endpoint_auth_method: parsed.token_endpoint_auth_method ?? "none",
          }),
        );
      });
      return;
    }
    if (req.method === "POST" && path === "/token" && tokenHandler) {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const tokens = tokenHandler(new URLSearchParams(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(tokens));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
