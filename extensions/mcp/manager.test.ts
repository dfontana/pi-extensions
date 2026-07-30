import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Manager, AuthError, type McpEnabledSnapshot, type ToolMeta } from "./manager.ts";
import type { ServerDef } from "./config.ts";
import { identity } from "./config.ts";

const serverModule = pathToFileURL(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))).href;
const stdioModule = pathToFileURL(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))).href;

function fixture(counter: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "mcp-fixture-")), "server.mjs");
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";
     import { Server } from ${JSON.stringify(serverModule)};
     import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
     import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))).href)};
     appendFileSync(${JSON.stringify(counter)}, "started\\n");
     const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
     server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
     server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: String(request.params.arguments?.value ?? "ok") }] }));
     await server.connect(new StdioServerTransport());`,
  );
  return path;
}

function server(name: string, script: string): ServerDef {
  return { name, command: process.execPath, args: [script], auth: "none" };
}

describe("mcp manager", () => {
  it("shares simultaneous connects and resets only its own live connection state", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "mcp-count-")), "starts");
    const def = server("fixture", fixture(counter));
    const manager = new Manager();
    await manager.initialize(new Map([[def.name, def]]));

    const [first, second] = await Promise.all([manager.connect(def.name), manager.connect(def.name)]);
    assert.deepEqual(first, second);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "one child process serves concurrent connects");
    assert.equal(manager.state(def.name), "off", "connection state does not imply the server is enabled");
    assert.deepEqual(await manager.callTool(def.name, "echo", { value: "still live" }), {
      text: "still live",
      isError: false,
    });

    await manager.initialize(new Map([[def.name, def]]));
    assert.equal(manager.enabled.size, 0);
    assert.equal(manager.state(def.name), "off");
    await manager.shutdown();
  });

  it("gives separate managers separate connections to the same server definition", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "mcp-count-")), "starts");
    const def = server("fixture", fixture(counter));
    const first = new Manager();
    const second = new Manager();
    await Promise.all([first.initialize(new Map([[def.name, def]])), second.initialize(new Map([[def.name, def]]))]);

    await Promise.all([first.connect(def.name), second.connect(def.name)]);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2);
    await first.shutdown();
    assert.deepEqual(await second.callTool(def.name, "echo", { value: "second survives" }), {
      text: "second survives",
      isError: false,
    });
    await second.shutdown();
  });

  it("snapshot() captures only enabled servers with their identities", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "mcp-snap-")), "starts");
    const def = server("snap-fixture", fixture(counter));
    const manager = new Manager();
    await manager.initialize(new Map([[def.name, def]]));

    // No servers enabled yet — snapshot should be empty.
    const emptySnap = manager.snapshot();
    assert.equal(emptySnap.version, 1);
    assert.equal(emptySnap.servers.length, 0);

    // Enable the server.
    manager.enabled.add(def.name);
    const snap = manager.snapshot();
    assert.equal(snap.version, 1);
    assert.equal(snap.servers.length, 1);
    assert.equal(snap.servers[0].name, def.name);
    assert.equal(snap.servers[0].identity, identity(def));

    await manager.shutdown();
  });

  it("initialize accepts only unique matching snapshot entries", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "mcp-snap-init-")), "starts");
    const def = server("snap-fixture", fixture(counter));
    const servers = new Map([[def.name, def]]);
    const matching = { name: def.name, identity: identity(def) };
    const cases: Array<{ label: string; snapshot: McpEnabledSnapshot; expected: string[] }> = [
      { label: "matching", snapshot: { version: 1, servers: [matching] }, expected: [def.name] },
      { label: "unknown", snapshot: { version: 1, servers: [{ name: "unknown", identity: "irrelevant" }] }, expected: [] },
      { label: "identity mismatch", snapshot: { version: 1, servers: [{ name: def.name, identity: "wrong" }] }, expected: [] },
      { label: "duplicate", snapshot: { version: 1, servers: [matching, matching] }, expected: [def.name] },
    ];
    const manager = new Manager();
    for (const { label, snapshot, expected } of cases) {
      await manager.initialize(servers, snapshot);
      assert.deepEqual([...manager.enabled], expected, label);
    }
    await manager.shutdown();
  });

  it("initialize with snapshot is mutation-isolated from the parent snapshot", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "mcp-snap-iso-")), "starts");
    const def = server("iso-server", fixture(counter));
    const servers = new Map([[def.name, def]]);

    // Parent manager with one enabled server.
    const parent = new Manager();
    await parent.initialize(servers);
    parent.enabled.add(def.name);
    const snap = parent.snapshot();

    // Child consumes the snapshot.
    const child = new Manager();
    await child.initialize(servers, snap);
    assert.ok(child.enabled.has(def.name), "child inherits enabled server");

    // Mutating the child's enabled set must not affect the parent's snapshot
    // or the parent's own enabled set.
    child.enabled.delete(def.name);
    assert.ok(parent.enabled.has(def.name), "parent enabled set unchanged after child mutation");

    // Mutating the parent after snapshot must not affect the child.
    parent.enabled.delete(def.name);
    assert.ok(child.enabled.size === 0, "child enabled set unchanged after parent mutation");

    // The snapshot itself must be isolated: mutating it does not affect either manager.
    snap.servers.push({ name: "injected", identity: "injected" });
    assert.equal(parent.enabled.size, 0, "parent unaffected by snapshot mutation");
    assert.equal(child.enabled.size, 0, "child unaffected by snapshot mutation");

    await parent.shutdown();
    await child.shutdown();
  });

  // ---- Implicit OAuth reconnect / latch tests ------------------------------
  //
  // These tests use the _tryConnect and _authImplicit seams to exercise the
  // UnauthorizedError → authImplicit → reconnect path without opening a browser
  // or making real network requests.  The seams replace only the raw transport
  // attempt and the auth call; all manager-level logic (latch, coalescing,
  // fail-fast) runs exactly as in production.

  it("implicit OAuth: UnauthorizedError triggers authImplicit then one reconnect that succeeds", async () => {
    const def: ServerDef = { name: "oauth-reconnect", url: "http://localhost/mock", auth: "oauth" };
    const servers = new Map([[def.name, def]]);
    const manager = new Manager();
    await manager.initialize(servers);
    manager.enabled.add(def.name);

    const tools: ToolMeta[] = [{ name: "do-thing", description: "works", inputSchema: { type: "object" } }];
    let tryConnectCalls = 0;
    let authImplicitCalls = 0;

    // First call: simulate 401. Second call (after auth): return tools.
    manager._tryConnect = async (_name) => {
      tryConnectCalls++;
      if (tryConnectCalls === 1) throw new UnauthorizedError();
      return tools;
    };

    manager._authImplicit = async (_def, _opts) => {
      authImplicitCalls++;
      // Auth succeeds; next reconnect will succeed.
    };

    const result = await manager.connect(def.name);

    assert.equal(tryConnectCalls, 2, "exactly two connection attempts: initial 401 + post-auth reconnect");
    assert.equal(authImplicitCalls, 1, "authImplicit called exactly once");
    assert.deepEqual(result, tools, "tools from the successful reconnect are returned");
    assert.equal(manager.getAuthFailures().size, 0, "no auth failure latched after successful reconnect");

    await manager.shutdown();
  });

  it("implicit OAuth latches, surfaces auth metadata, and can be retried", async () => {
    const def: ServerDef = { name: "oauth-latch", url: "http://localhost/mock", auth: "oauth" };
    const servers = new Map([[def.name, def]]);
    const manager = new Manager();
    await manager.initialize(servers);
    manager.enabled.add(def.name);

    const tools: ToolMeta[] = [{ name: "do-thing", inputSchema: { type: "object" } }];
    let tryConnectCalls = 0;
    let authImplicitCalls = 0;
    let allowConnect = false;
    manager._tryConnect = async () => {
      tryConnectCalls++;
      if (!allowConnect) throw new UnauthorizedError();
      return tools;
    };
    manager._authImplicit = async () => {
      authImplicitCalls++;
    };

    await assert.rejects(() => manager.connect(def.name), AuthError);
    assert.equal(tryConnectCalls, 2);
    assert.equal(authImplicitCalls, 1);
    assert.equal(manager.state(def.name), "needs-auth");
    const message = manager.getAuthFailures().get(def.name);
    assert.ok(message?.includes("Do not retry automatically"));
    const enabled = await manager.enabledMetadata();
    assert.equal(enabled.meta.has(def.name), false);
    assert.equal(enabled.authFailed.get(def.name), message);

    tryConnectCalls = 0;
    authImplicitCalls = 0;
    await assert.rejects(() => manager.connect(def.name), AuthError);
    assert.equal(tryConnectCalls, 1);
    assert.equal(authImplicitCalls, 0);

    manager.clearAuthLatch(def.name);
    assert.equal(manager.state(def.name), "idle");
    assert.equal(manager.getAuthFailures().size, 0);
    allowConnect = true;
    assert.deepEqual(await manager.connect(def.name), tools);
    assert.notEqual(manager.state(def.name), "needs-auth");

    await manager.initialize(servers);
    assert.equal(manager.enabled.size, 0);
    assert.equal(manager.state(def.name), "off");
    assert.equal(manager.getAuthFailures().size, 0);
    await manager.shutdown();
  });
});
