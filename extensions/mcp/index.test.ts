import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mcpExtension from "./index.ts";

interface Binding {
  tool: {
    promptSnippet?: string;
    execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  events: Map<string, (...args: any[]) => Promise<void>>;
}

function bind(): Binding {
  const binding: Partial<Binding> = {
    events: new Map<string, (...args: any[]) => Promise<void>>(),
  };
  const api = {
    registerTool(value: Binding["tool"]) {
      binding.tool = value;
    },
    registerCommand() {},
    on(event: string, handler: (...args: any[]) => Promise<void>) {
      binding.events!.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  mcpExtension(api);
  assert.ok(binding.tool, "the extension registers its MCP tool");
  return binding as Binding;
}

const ui = {
  theme: { fg: (_color: string, text: string) => text },
  setStatus() {},
};

function context(cwd: string) {
  return { cwd, ui, signal: undefined } as any;
}

describe("mcp index", () => {
  it("seeds the tool prompt with configured server names", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-prompt-"));
    const server = "prompt server (raw)";
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { [server]: {} } }));

    const binding = bind();
    const sessionStart = binding.events.get("session_start");
    assert.ok(sessionStart);

    await sessionStart({}, context(cwd));

    const promptSnippet = binding.tool.promptSnippet ?? "";
    assert.match(promptSnippet, /Configured MCP servers:/);
    assert.ok(promptSnippet.includes(server));
  });

  it("keeps enabled servers isolated between extension factory bindings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const server = "session-isolation-test";
    // Invalid on purpose: connect enables the server before reporting its bad
    // definition, without needing a real process or network fixture.
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { [server]: {} } }));

    const parent = bind();
    const child = bind();
    const parentStart = parent.events.get("session_start");
    const childStart = child.events.get("session_start");
    assert.ok(parentStart);
    assert.ok(childStart);

    await parentStart({}, context(cwd));
    await assert.rejects(parent.tool.execute("id", { connect: server }, undefined, undefined, context(cwd)), /neither/);

    await childStart({}, context(cwd));
    const parentStatus = await parent.tool.execute("id", {}, undefined, undefined, context(cwd));
    const childStatus = await child.tool.execute("id", {}, undefined, undefined, context(cwd));

    assert.match(parentStatus.content[0].text, /MCP servers \(1\/\d+ enabled\)/);
    assert.match(childStatus.content[0].text, /MCP servers \(0\/\d+ enabled\)/);
  });
});
