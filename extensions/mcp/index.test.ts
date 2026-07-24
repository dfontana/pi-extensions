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
  commands: Map<string, { handler: (argStr: string, ctx: any) => Promise<void> }>;
  events: Map<string, (...args: any[]) => Promise<void>>;
}

function bind(): Binding {
  const binding: Partial<Binding> = {
    commands: new Map<string, { handler: (argStr: string, ctx: any) => Promise<void> }>(),
    events: new Map<string, (...args: any[]) => Promise<void>>(),
  };
  const api = {
    registerTool(value: Binding["tool"]) {
      binding.tool = value;
    },
    registerCommand(name: string, command: { handler: (argStr: string, ctx: any) => Promise<void> }) {
      binding.commands!.set(name, command);
    },
    on(event: string, handler: (...args: any[]) => Promise<void>) {
      binding.events!.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  mcpExtension(api);
  assert.ok(binding.tool, "the extension registers its MCP tool");
  return binding as Binding;
}

const testTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const ui = {
  theme: testTheme,
  setStatus() {},
};

function context(cwd: string, contextUi = ui) {
  return { cwd, ui: contextUi, signal: undefined } as any;
}

interface PanelComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

function panelHarness() {
  let panel: PanelComponent | undefined;
  let renderRequests = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const panelUi = {
    ...ui,
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
    custom<T>(factory: (tui: { requestRender(): void }, theme: typeof testTheme, keybindings: unknown, done: (value: T) => void) => PanelComponent) {
      return new Promise<T>((resolve) => {
        panel = factory({ requestRender: () => renderRequests++ }, testTheme, {}, resolve);
      });
    },
  };
  return {
    ui: panelUi,
    notifications,
    get panel() {
      assert.ok(panel, "the /mcp command opens a custom panel");
      return panel;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}

function writeServerConfig(cwd: string, names: string[]) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, {}])) }));
}

async function openPanel(binding: Binding, cwd: string) {
  const command = binding.commands.get("mcp");
  assert.ok(command, "the extension registers the /mcp command");
  const harness = panelHarness();
  const result = command.handler("", context(cwd, harness.ui));
  return { harness, result };
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

  it("filters servers from immediate printable input and toggles the selected match", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-panel-filter-"));
    writeServerConfig(cwd, ["alpha", "bravo", "charlie"]);

    const binding = bind();
    const sessionStart = binding.events.get("session_start");
    assert.ok(sessionStart);
    await sessionStart({}, context(cwd));

    const { harness, result } = await openPanel(binding, cwd);
    assert.match(harness.panel.render(78).join("\n"), /filter: █/);

    harness.panel.handleInput("r");
    harness.panel.handleInput("\x1b[B");
    assert.match(harness.panel.render(78).join("\n"), /▸ · charlie/);
    harness.panel.handleInput("\x1b[A");
    assert.match(harness.panel.render(78).join("\n"), /▸ · bravo/);
    harness.panel.handleInput("\x1b[B");
    harness.panel.handleInput(" ");
    assert.match(harness.panel.render(78).join("\n"), /▸ ○ charlie/);

    let rendered = harness.panel.render(78).join("\n");
    assert.match(rendered, /filter: r█/);
    assert.match(rendered, /bravo/);
    assert.match(rendered, /charlie/);
    assert.doesNotMatch(rendered, /alpha/);

    harness.panel.handleInput("\x7f");
    harness.panel.handleInput("\x1b[114u"); // Kitty CSI-u plain "r"
    harness.panel.handleInput("a");
    rendered = harness.panel.render(78).join("\n");
    assert.match(rendered, /filter: ra█/);
    assert.match(rendered, /bravo/);
    assert.doesNotMatch(rendered, /charlie/);

    harness.panel.handleInput("z");
    rendered = harness.panel.render(78).join("\n");
    assert.match(rendered, /No matching MCP servers\./);
    harness.panel.handleInput(" ");
    harness.panel.handleInput("R");
    harness.panel.handleInput("A");
    assert.match(harness.panel.render(78).join("\n"), /No matching MCP servers\./);

    harness.panel.handleInput("\x1b");
    await result;
    const status = await binding.tool.execute("id", {}, undefined, undefined, context(cwd));
    assert.match(status.content[0].text, /MCP servers \(1\/\d+ enabled\)/);
  });

  it("uses shifted R and A for restart and reauthentication", async () => {
    const restartCwd = mkdtempSync(join(tmpdir(), "mcp-panel-restart-"));
    writeServerConfig(restartCwd, ["restartable"]);

    const restartBinding = bind();
    const restartStart = restartBinding.events.get("session_start");
    assert.ok(restartStart);
    await restartStart({}, context(restartCwd));

    const restartPanel = await openPanel(restartBinding, restartCwd);
    restartPanel.harness.panel.handleInput("r");
    assert.match(restartPanel.harness.panel.render(78).join("\n"), /filter: r█/);
    restartPanel.harness.panel.handleInput("R");
    assert.match(restartPanel.harness.panel.render(78).join("\n"), /connecting…/);
    restartPanel.harness.panel.handleInput("\x1b");
    await restartPanel.result;
    const restartStatus = await restartBinding.tool.execute("id", {}, undefined, undefined, context(restartCwd));
    assert.match(restartStatus.content[0].text, /MCP servers \(1\/\d+ enabled\)/);

    const authCwd = mkdtempSync(join(tmpdir(), "mcp-panel-auth-"));
    writeServerConfig(authCwd, ["authable"]);

    const authBinding = bind();
    const authStart = authBinding.events.get("session_start");
    assert.ok(authStart);
    await authStart({}, context(authCwd));

    const authPanel = await openPanel(authBinding, authCwd);
    for (const key of "authable") authPanel.harness.panel.handleInput(key);
    assert.match(authPanel.harness.panel.render(78).join("\n"), /filter: authable█/);
    authPanel.harness.panel.handleInput("A");
    await authPanel.result;
    assert.deepEqual(authPanel.harness.notifications, [
      { message: '"authable" is not an HTTP/OAuth server.', level: "warning" },
    ]);
  });
});
