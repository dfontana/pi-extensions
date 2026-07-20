import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

// config.ts resolves the agent directory while it loads, so this must be set
// before dynamically importing the OAuth module under test.
const agentDir = mkdtempSync(join(tmpdir(), "mcp-auth-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { clearOAuthCredentials } = await import("./auth.ts");

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
});

process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
