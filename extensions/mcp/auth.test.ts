import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

// config.ts resolves the agent directory while it loads, so this must be set
// before dynamically importing the OAuth module under test.
const agentDir = mkdtempSync(join(tmpdir(), "mcp-auth-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { clearOAuthCredentials, authImplicit, authInteractive, AuthError } = await import("./auth.ts");

const authFile = join(agentDir, "mcp", "auth.json");

function writeAuthState(state: unknown): void {
  mkdirSync(dirname(authFile), { recursive: true });
  writeFileSync(authFile, JSON.stringify(state));
}

function readAuthState(): unknown {
  return JSON.parse(readFileSync(authFile, "utf8"));
}

describe("mcp auth", () => {
  it("clears every saved OAuth field for only the selected server", () => {
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

    clearOAuthCredentials({ name: "reauth", url, auth: "oauth" });

    assert.deepEqual(readAuthState(), { [otherUrl]: other });
  });

  it("AuthError carries server name and isAuthError flag", () => {
    const err = new AuthError("test message — Do not retry automatically.", "my-server");
    assert.equal(err.serverName, "my-server");
    assert.equal(err.isAuthError, true);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AuthError");
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
      const mock = test.mockDelayMs !== undefined ? await startMockOAuthServer(undefined, test.mockDelayMs) : undefined;
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
  it("concurrent authImplicit calls coalesce to one browser flow", async () => {
    // Spin up a minimal OAuth mock server so the auth() SDK can complete discovery
    // and DCR and reach the redirectToAuthorization step where openBrowserFn is called.
    let dcrCount = 0;
    const { server: mockServer, port: mockPort } = await startMockOAuthServer(() => dcrCount++);
    const url = `http://localhost:${mockPort}`;
    const def = { name: "coalesce-server", url, auth: "oauth" as const };

    let browserOpenCount = 0;
    const openBrowserFn = async (_u: string): Promise<void> => {
      browserOpenCount++;
      throw new Error("Simulated display failure");
    };

    // Launch two concurrent calls to authImplicit for the same URL.
    const results = await Promise.allSettled([
      authImplicit(def, { openBrowserFn, deadlineMs: 10_000 }),
      authImplicit(def, { openBrowserFn, deadlineMs: 10_000 }),
    ]);

    mockServer.close();

    // Both should have rejected (browser launch failed).
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "rejected");

    // Only ONE browser open should have been attempted (second call waited for first).
    assert.equal(browserOpenCount, 1, "only one browser launch for concurrent calls");
    // DCR should also have been performed at most once.
    assert.ok(dcrCount <= 1, `DCR called ${dcrCount} times; expected at most 1`);
  });

  it("authInteractive does not coalesce — each call runs its own flow", async () => {
    // authInteractive bypasses the coalescing cache; each call runs its own
    // independent browser flow. Two concurrent calls must each open the browser.
    // (Exact DCR counts are incidental — they share auth.json and may coalesce
    // at the registration level without violating the browser-independence contract.)
    const { server: mockServer, port: mockPort } = await startMockOAuthServer();
    const url = `http://localhost:${mockPort}`;
    const def = { name: "no-coalesce-server", url, auth: "oauth" as const };

    let browserOpenCount = 0;
    const openBrowserFn = async (_u: string): Promise<void> => {
      browserOpenCount++;
      throw new Error("Simulated display failure");
    };

    await Promise.allSettled([
      authInteractive(def, { openBrowserFn, deadlineMs: 10_000 }),
      authInteractive(def, { openBrowserFn, deadlineMs: 10_000 }),
    ]);

    mockServer.close();

    // Both authInteractive calls must have reached the browser-launch step.
    assert.equal(browserOpenCount, 2, "authInteractive does not coalesce — two browser launches");
  });

});

// ---- Mock OAuth server helper --------------------------------------------

/**
 * Minimal OAuth 2.0 authorization server mock. Responds to:
 *   GET  /  (or /.well-known/...)  — server metadata
 *   POST /register                  — dynamic client registration
 * Enough for the MCP SDK auth() to complete discovery + DCR and call
 * redirectToAuthorization, which triggers the injected openBrowserFn.
 */
async function startMockOAuthServer(
  onDcr?: () => void,
  responseDelayMs = 0,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET") {
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
            client_id: "test-client",
            redirect_uris: (parsed.redirect_uris as string[]) ?? [],
            grant_types: (parsed.grant_types as string[]) ?? ["authorization_code"],
            response_types: (parsed.response_types as string[]) ?? ["code"],
          }),
        );
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
