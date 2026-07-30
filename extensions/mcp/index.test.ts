import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const testAgentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => rmSync(testAgentDir, { recursive: true, force: true }));

const { default: mcpExtension } = await import("./index.ts");

interface Binding {
  tool: {
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  commands: Map<string, { handler: (argStr: string, ctx: any) => Promise<void> }>;
  events: Map<string, (...args: any[]) => Promise<void>>;
  piEvents: Map<string, Array<(data: unknown) => void>>;
}

function bind(): Binding {
  const binding: Partial<Binding> = {
    commands: new Map(),
    events: new Map(),
    piEvents: new Map(),
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
    events: {
      emit(channel: string, data: unknown) {
        for (const h of binding.piEvents!.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!binding.piEvents!.has(channel)) binding.piEvents!.set(channel, []);
        binding.piEvents!.get(channel)!.push(handler);
        return () => {
          const arr = binding.piEvents!.get(channel);
          if (arr) {
            const idx = arr.indexOf(handler);
            if (idx >= 0) arr.splice(idx, 1);
          }
        };
      },
    },
    getSessionName: () => undefined as string | undefined,
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

function context(cwd: string, contextUi = ui, sessionName?: string) {
  return {
    cwd,
    ui: contextUi,
    signal: undefined,
    sessionManager: {
      getSessionName: () => sessionName,
    },
  } as any;
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
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, {}])) }),
  );
}

async function openPanel(binding: Binding, cwd: string) {
  const command = binding.commands.get("mcp");
  assert.ok(command, "the extension registers the /mcp command");
  const harness = panelHarness();
  const result = command.handler("", context(cwd, harness.ui));
  return { harness, result };
}

async function enableFirstServer(binding: Binding, cwd: string): Promise<void> {
  const panel = await openPanel(binding, cwd);
  panel.harness.panel.handleInput(" ");
  panel.harness.panel.handleInput("\x1b");
  await panel.result;
}

async function assertEnabledCount(binding: Binding, cwd: string, count: number, message?: string): Promise<void> {
  const status = await binding.tool.execute("id", {}, undefined, undefined, context(cwd));
  assert.match(status.content[0].text, new RegExp(`MCP servers \\(${count}/\\d+ enabled\\)`), message);
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

  it("schema, description, and guidelines contain no connect or action lifecycle modes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-schema-"));

    const binding = bind();

    // Schema must not expose 'connect' or 'action' fields.
    const schema = binding.tool.parameters as { properties?: Record<string, unknown> };
    assert.ok(!("connect" in (schema.properties ?? {})), "schema must not have 'connect' field");
    assert.ok(!("action" in (schema.properties ?? {})), "schema must not have 'action' field");

    // Description must not mention 'connect' or 'auth-start'/'auth-complete'.
    const desc = binding.tool.description;
    assert.doesNotMatch(desc, /mcp\(\{connect\}/, "description must not advertise connect mode");
    assert.doesNotMatch(desc, /auth-start/, "description must not advertise auth-start");
    assert.doesNotMatch(desc, /auth-complete/, "description must not advertise auth-complete");

    // Guidelines must not instruct the agent to connect or authenticate manually.
    const guidelines = binding.tool.promptGuidelines ?? [];
    const guideText = guidelines.join("\n");
    assert.doesNotMatch(guideText, /mcp\(\{connect\}/, "guidelines must not reference connect mode");
    assert.doesNotMatch(guideText, /auth-start/, "guidelines must not reference auth-start");
    assert.doesNotMatch(guideText, /auth-complete/, "guidelines must not reference auth-complete");
    // Guidelines should mention that authentication is automatic and recovery uses /mcp.
    assert.match(guideText, /automatic|implicit/i, "guidelines should mention automatic auth");
    assert.match(guideText, /\/mcp|Shift\+[AR]/i, "guidelines should reference /mcp panel recovery");

    await sessionStart(cwd, binding, context(cwd));
    const snippet = binding.tool.promptSnippet ?? "";
    assert.doesNotMatch(snippet, /connect/, "prompt snippet must not mention connect");
    assert.doesNotMatch(snippet, /auth-start/, "prompt snippet must not mention auth-start");
  });

  it("keeps enabled servers isolated between extension factory bindings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const server = "session-isolation-test";
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { [server]: {} } }));

    const parent = bind();
    const child = bind();
    const parentStart = parent.events.get("session_start");
    const childStart = child.events.get("session_start");
    assert.ok(parentStart);
    assert.ok(childStart);

    await parentStart({}, context(cwd));
    await childStart({}, context(cwd));

    await enableFirstServer(parent, cwd);
    await assertEnabledCount(parent, cwd, 1);
    await assertEnabledCount(child, cwd, 0);
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

  it("subagent snapshot broker: single-child handoffs require an unambiguous 8-character suffix", async () => {
    const cases = [
      {
        label: "inherits the parent's enabled snapshot",
        serverName: "broker-server",
        startedIds: ["abcdef0123456789a"],
        childSessionName: "general-purpose#abcdef01",
        expectedEnabledCount: 1,
      },
      {
        label: "independent session without # stays disabled",
        serverName: "independent-server",
        startedIds: ["abcdef0123456789a"],
        childSessionName: "independent-session",
        expectedEnabledCount: 0,
      },
      {
        label: "one-character suffix cannot consume a pending snapshot",
        serverName: "short-suffix-server",
        startedIds: ["abcdef0123456789a"],
        childSessionName: "normal#a",
        expectedEnabledCount: 0,
      },
      {
        label: "ambiguous prefix fails closed",
        serverName: "ambiguous-prefix-server",
        startedIds: ["12345678aaaaaaaaa", "12345678bbbbbbbbb"],
        childSessionName: "general-purpose#12345678",
        expectedEnabledCount: 0,
      },
    ];

    for (const testCase of cases) {
      const cwd = mkdtempSync(join(tmpdir(), "mcp-broker-case-"));
      writeServerConfig(cwd, [testCase.serverName]);

      const parent = bind();
      await parent.events.get("session_start")!({}, context(cwd));
      await enableFirstServer(parent, cwd);

      for (const id of testCase.startedIds) {
        parent.piEvents.get("subagents:started")?.forEach((h) => h({ id }));
      }

      const child = bind();
      await child.events.get("session_start")!({}, context(cwd, ui, testCase.childSessionName));
      await assertEnabledCount(child, cwd, testCase.expectedEnabledCount, testCase.label);

      for (const id of testCase.startedIds) {
        parent.piEvents.get("subagents:failed")?.forEach((h) => h({ id }));
      }
    }
  });

  it("subagent broker: consumed entry is not re-used by a second child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-broker-once-"));
    writeServerConfig(cwd, ["once-server"]);

    const parent = bind();
    await parent.events.get("session_start")!({}, context(cwd));
    await enableFirstServer(parent, cwd);

    const agentId = "deadbeef00000001a";
    parent.piEvents.get("subagents:started")?.forEach((h) =>
      h({ id: agentId, type: "general-purpose", description: "first" }),
    );

    // First child consumes the entry.
    const child1 = bind();
    await child1.events.get("session_start")!({}, context(cwd, ui, `general-purpose#${agentId.slice(0, 8)}`));
    await assertEnabledCount(child1, cwd, 1, "first child inherits");

    // Second child with the same suffix gets nothing (entry was consumed).
    const child2 = bind();
    await child2.events.get("session_start")!({}, context(cwd, ui, `general-purpose#${agentId.slice(0, 8)}`));
    await assertEnabledCount(child2, cwd, 0, "entry consumed: second child gets nothing");
  });

  it("subagent broker: completed/failed events clean up pending entries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-broker-cleanup-"));
    writeServerConfig(cwd, ["cleanup-server"]);

    const parent = bind();
    await parent.events.get("session_start")!({}, context(cwd));
    await enableFirstServer(parent, cwd);

    const agentIdCompleted = "aaaaaaaa111111111";
    const agentIdFailed = "bbbbbbbb222222222";

    parent.piEvents.get("subagents:started")?.forEach((h) =>
      h({ id: agentIdCompleted, type: "general-purpose", description: "completed" }),
    );
    parent.piEvents.get("subagents:started")?.forEach((h) =>
      h({ id: agentIdFailed, type: "general-purpose", description: "failed" }),
    );

    // Simulate completion/failure before any child session_start.
    parent.piEvents.get("subagents:completed")?.forEach((h) => h({ id: agentIdCompleted }));
    parent.piEvents.get("subagents:failed")?.forEach((h) => h({ id: agentIdFailed }));

    // A child with either suffix should now get nothing (cleaned up).
    const child1 = bind();
    await child1.events.get("session_start")!({}, context(cwd, ui, `general-purpose#${agentIdCompleted.slice(0, 8)}`));
    await assertEnabledCount(child1, cwd, 0, "completed entry was cleaned up");

    const child2 = bind();
    await child2.events.get("session_start")!({}, context(cwd, ui, `general-purpose#${agentIdFailed.slice(0, 8)}`));
    await assertEnabledCount(child2, cwd, 0, "failed entry was cleaned up");
  });

  it("rejected Shift+R restart renders the error until the display timeout", async () => {
    // This test exercises the R1 bug: 'finally' previously called busy.delete(name)
    // immediately, erasing the catch-block error before it could render.
    const { mock } = await import("node:test");
    const cwd = mkdtempSync(join(tmpdir(), "mcp-restart-err-"));
    // Server with no command or url — connect rejects immediately (no I/O).
    writeServerConfig(cwd, ["fail-server"]);

    const binding = bind();
    await binding.events.get("session_start")!({}, context(cwd));

    // Mock setTimeout so the 4-second display cleanup timer never fires for real.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { harness, result } = await openPanel(binding, cwd);

      // Filter to "fail" so that only "fail-server" is visible and focused.
      // Without the filter, any globally-configured server (e.g. atlassian)
      // would be focused first, and Shift+R would attempt to connect that one.
      for (const ch of "fail") harness.panel.handleInput(ch);
      assert.match(harness.panel.render(78).join("\n"), /fail-server/);

      // Shift+R triggers restart; status shows "connecting…" synchronously.
      harness.panel.handleInput("R");
      assert.match(harness.panel.render(78).join("\n"), /connecting…/);

      // Flush microtasks: the invalid-server rejection propagates through the
      // async chain (no real I/O), so a handful of Promise yields is enough.
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // After the failure the error must be visible (not cleared by finally).
      assert.match(
        harness.panel.render(78).join("\n"),
        /✗/,
        "failed restart must show error in panel",
      );

      // Advance the mock clock past the 4-second display window.
      mock.timers.tick(4001);

      // Error should now be cleared by the scheduled cleanup.
      assert.doesNotMatch(
        harness.panel.render(78).join("\n"),
        /✗/,
        "error clears after the display timeout",
      );

      harness.panel.handleInput("\x1b");
      await result;
    } finally {
      mock.timers.reset();
    }
  });

});

// Helper to trigger session_start on a binding.
async function sessionStart(cwd: string, binding: Binding, ctx: any): Promise<void> {
  const handler = binding.events.get("session_start");
  if (handler) await handler({}, ctx);
}
