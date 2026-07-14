import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Manager } from "./manager.ts";
import type { ServerDef } from "./config.ts";

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
});
