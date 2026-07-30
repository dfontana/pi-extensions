import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";

const testAgentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => rmSync(testAgentDir, { recursive: true, force: true }));

const { default: mcpExtension, MCP_ACTIONS } = await import("./index.ts");

interface Binding {
  tool: {
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
    renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
    renderResult?: (result: any, options: any, theme: any, context: any) => { render(width: number): string[] };
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
  const status = await binding.tool.execute("id", { action: "status" }, undefined, undefined, context(cwd));
  assert.match(status.content[0].text, new RegExp(`MCP servers \\(${count}/\\d+ enabled\\)`), message);
}

// ---- schema validation helper ---------------------------------------------

function validate(binding: Binding, args: Record<string, unknown>) {
  return validateToolArguments(
    { name: "mcp", description: binding.tool.description, parameters: binding.tool.parameters } as any,
    { type: "toolCall" as const, id: "1", name: "mcp", arguments: args },
  );
}

function expectInvalid(binding: Binding, args: Record<string, unknown>, label: string) {
  assert.throws(() => validate(binding, args), (e) => e instanceof Error, `should reject: ${label}`);
}

describe("mcp index", () => {
  // ---- schema contract tests -----------------------------------------------

  describe("mcp schema", () => {
    it("exposes the hybrid schema and compatible root projection", () => {
      const binding = bind();
      const schema = binding.tool.parameters as Record<string, unknown>;
      const projection = {
        type: schema.type,
        properties: schema.properties,
        required: schema.required,
      };
      const props = projection.properties as Record<string, unknown>;

      assert.equal(projection.type, "object");
      assert.deepEqual(projection.required, ["action"]);
      assert.equal(schema.additionalProperties, false);
      for (const key of ["action", "server", "search", "regex", "tool", "args"]) {
        assert.ok(key in props, `root projection must contain "${key}"`);
      }
      assert.ok(!("connect" in props), "schema must not have 'connect' field");

      const actionSchema = props.action as Record<string, unknown>;
      assert.equal(actionSchema.type, "string");
      assert.deepEqual(
        [...(actionSchema.enum as string[])].sort(),
        [...MCP_ACTIONS].sort(),
        "action enum must match MCP_ACTIONS",
      );

      const anyOf = schema.anyOf as unknown[];
      assert.ok(Array.isArray(anyOf));
      assert.equal(anyOf.length, 5, "anyOf must have exactly 5 branches");
    });

    const validCases: Array<{ label: string; args: Record<string, unknown> }> = [
      { label: "status", args: { action: "status" } },
      { label: "list-tools", args: { action: "list-tools", server: "datadog" } },
      { label: "search-tools without regex", args: { action: "search-tools", search: "monitor" } },
      { label: "search-tools with regex:false", args: { action: "search-tools", search: "monitor", regex: false } },
      { label: "search-tools with regex:true", args: { action: "search-tools", search: "^mon", regex: true } },
      { label: "describe-tool", args: { action: "describe-tool", tool: "datadog_get_monitor" } },
      { label: "invoke-tool without args", args: { action: "invoke-tool", tool: "datadog_get_monitor" } },
      { label: "invoke-tool with args", args: { action: "invoke-tool", tool: "datadog_get_monitor", args: '{"id":123}' } },
    ];

    it("accepts valid canonical shapes", () => {
      const binding = bind();
      for (const { label, args } of validCases) {
        assert.doesNotThrow(() => validate(binding, args), `should accept: ${label}`);
      }
    });

    const invalidCases: Array<{ label: string; args: Record<string, unknown> }> = [
      { label: "legacy mcp({})", args: {} },
      { label: 'legacy mcp({server:"datadog"})', args: { server: "datadog" } },
      { label: 'legacy mcp({tool:"…"})', args: { tool: "datadog_get_monitor" } },
      { label: "unknown action: connect", args: { action: "connect" } },
      { label: "unknown action: auth-start", args: { action: "auth-start" } },
      { label: "unknown action: unknown", args: { action: "unknown" } },
      { label: "extra property on status", args: { action: "status", unknownField: "xyz" } },
      { label: "status + server", args: { action: "status", server: "datadog" } },
      { label: "status + search", args: { action: "status", search: "monitor" } },
      { label: "list-tools + search", args: { action: "list-tools", server: "datadog", search: "monitor" } },
      { label: "search-tools + server", args: { action: "search-tools", search: "monitor", server: "datadog" } },
      { label: "regex on invoke-tool", args: { action: "invoke-tool", tool: "datadog_get_monitor", regex: true } },
      { label: "args on describe-tool", args: { action: "describe-tool", tool: "datadog_get_monitor", args: '{"x":1}' } },
      { label: "args on search-tools", args: { action: "search-tools", search: "monitor", args: "{}" } },
      { label: "list-tools without server", args: { action: "list-tools" } },
      { label: "search-tools without search", args: { action: "search-tools" } },
      { label: "describe-tool without tool", args: { action: "describe-tool" } },
      { label: "invoke-tool without tool", args: { action: "invoke-tool" } },
      { label: "args as object instead of string", args: { action: "invoke-tool", tool: "datadog_get_monitor", args: { id: 123 } as any } },
    ];

    it("rejects invalid, legacy, and cross-action shapes", () => {
      const binding = bind();
      for (const { label, args } of invalidCases) expectInvalid(binding, args, label);
    });
  });

  // ---- prompt contract tests -----------------------------------------------

  describe("mcp prompt", () => {
    it("exposes canonical actions, configured servers, and recovery guidance", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "mcp-prompt-"));
      const server = "prompt server (raw)";
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { [server]: {} } }));

      const binding = bind();
      await sessionStart(cwd, binding, context(cwd));

      const description = binding.tool.description;
      const guidelines = (binding.tool.promptGuidelines ?? []).join("\n");
      const snippet = binding.tool.promptSnippet ?? "";
      const prompt = [description, guidelines, snippet].join("\n");

      for (const action of MCP_ACTIONS) {
        assert.ok(prompt.includes(action), `action "${action}" must appear in prompt surfaces`);
      }
      for (const form of [/action:\s*"status"/, /action:\s*"search-tools"/, /action:\s*"invoke-tool"/]) {
        assert.match(prompt, form, "prompt must show canonical action calls");
      }
      for (const form of [/mcp\(\{connect/, /auth-start/, /auth-complete/]) {
        assert.doesNotMatch(prompt, form, "prompt must not advertise lifecycle actions");
      }

      assert.match(guidelines, /automatic|implicit/i);
      assert.match(guidelines, /\/mcp|Shift\+[AR]/i);
      assert.match(snippet, /Configured MCP servers:/);
      assert.ok(snippet.includes(server));
      assert.doesNotMatch(snippet, /connect|auth-start|auth-complete/);
    });
  });

  // ---- dispatch / render tests ---------------------------------------------

  describe("mcp dispatch", () => {
    const dispatchCases: Array<{
      label: string;
      args: Record<string, unknown>;
      expected: RegExp[];
      rejects?: boolean;
    }> = [
      { label: "status returns server list", args: { action: "status" }, expected: [/MCP servers/] },
      {
        label: "search-tools reports no matches for disabled servers",
        args: { action: "search-tools", search: "anything" },
        expected: [/No enabled servers|No tools match/],
      },
      {
        label: "list-tools reports an unknown server",
        args: { action: "list-tools", server: "nonexistent" },
        expected: [/Unknown server "nonexistent"/],
      },
      {
        label: "describe-tool reports an unknown tool and search hint",
        args: { action: "describe-tool", tool: "nonexistent_tool" },
        expected: [/not found/, /action:\s*"search-tools"/],
      },
      {
        label: "invoke-tool throws for an unknown tool with search hint",
        args: { action: "invoke-tool", tool: "nonexistent_tool" },
        expected: [/not found/, /search-tools/],
        rejects: true,
      },
    ];

    for (const { label, args, expected, rejects } of dispatchCases) {
      it(label, async () => {
        const cwd = mkdtempSync(join(tmpdir(), "mcp-dispatch-"));
        writeServerConfig(cwd, ["some-server"]);
        const binding = bind();
        await sessionStart(cwd, binding, context(cwd));
        const execute = () => binding.tool.execute("id", args, undefined, undefined, context(cwd));

        if (rejects) {
          await assert.rejects(execute, (e: Error) => {
            for (const matcher of expected) assert.match(e.message, matcher);
            return true;
          });
        } else {
          const text = (await execute()).content[0].text;
          for (const matcher of expected) assert.match(text, matcher);
        }
      });
    }
  });

  // ---- render contract tests -----------------------------------------------
  describe("mcp render", () => {
    function makeRenderCtx(args: Record<string, unknown>): any {
      return {
        args,
        toolCallId: "test-id",
        invalidate: () => {},
        lastComponent: undefined,
        // done=false, spinnerTimer pre-set to a truthy sentinel so the
        // production code skips creating a real setInterval (and avoids the
        // keyHint call that requires the interactive theme to be initialized).
        // clearInterval(1) is a safe no-op for an unknown timer id.
        state: { done: false, isError: false, frameIdx: 0, spinnerTimer: 1 as any },
        cwd: "/tmp",
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: true,
        showImages: false,
        isError: false,
      };
    }

    function makeResult(text: string): any {
      return { content: [{ type: "text", text }], details: undefined };
    }

    const renderCallCases: Array<[string, Record<string, unknown>, string[]]> = [
      ["status", { action: "status" }, ["mcp", "status"]],
      ["list-tools", { action: "list-tools", server: "myserver" }, ["mcp", "list", "myserver"]],
      ["search-tools", { action: "search-tools", search: "monitor" }, ["mcp", "search", '"monitor"']],
      ["describe-tool", { action: "describe-tool", tool: "svc_get_x" }, ["mcp", "describe", "svc_get_x"]],
      ["invoke-tool with args", { action: "invoke-tool", tool: "svc_get_x", args: '{"n":1}' }, ["mcp", "call svc_get_x", '{"n":1}']],
      ["invoke-tool without args", { action: "invoke-tool", tool: "svc_get_x" }, ["mcp", "call svc_get_x"]],
    ];

    for (const [label, args, wantInOutput] of renderCallCases) {
      it(`renderCall summary: ${label}`, () => {
        const binding = bind();
        assert.ok(binding.tool.renderCall, "renderCall must be registered on the mcp tool");
        const output = binding.tool.renderCall!(args, testTheme, makeRenderCtx(args)).render(160).join(" ");
        for (const want of wantInOutput) assert.ok(output.includes(want), `"${label}" must include "${want}"`);
      });
    }

    const renderResultCases: Array<[string, Record<string, unknown>, string, string | undefined, string | undefined]> = [
      ["status — result text rendered, no context line", { action: "status" }, "servers ok", "servers ok", "server:"],
      ["list-tools — shows server", { action: "list-tools", server: "myserver" }, "tool_a — does a", "server: myserver", undefined],
      ["search-tools — shows query", { action: "search-tools", search: "monitor" }, '1 match for "monitor"', "query: monitor", undefined],
      ["describe-tool — shows tool", { action: "describe-tool", tool: "svc_get_x" }, "input schema: {}", "tool: svc_get_x", undefined],
      ["invoke-tool with args — shows args", { action: "invoke-tool", tool: "svc_get_x", args: '{"n":1}' }, "done", 'args: {"n":1}', undefined],
      ["invoke-tool without args — no args line", { action: "invoke-tool", tool: "svc_get_x" }, "done", undefined, "args:"],
    ];

    for (const [label, args, resultText, wantLine, noLine] of renderResultCases) {
      it(`renderResult expanded: ${label}`, () => {
        const binding = bind();
        assert.ok(binding.tool.renderResult, "renderResult must be registered on the mcp tool");
        const output = binding.tool.renderResult!(
          makeResult(resultText),
          { expanded: true, isPartial: false },
          testTheme,
          makeRenderCtx(args),
        ).render(200).join("\n");
        if (wantLine) assert.ok(output.includes(wantLine), `"${label}" must include "${wantLine}"`);
        if (noLine) assert.ok(!output.includes(noLine), `"${label}" must not include "${noLine}"`);
      });
    }

    it("renderResult collapsed returns empty component", () => {
      const binding = bind();
      assert.ok(binding.tool.renderResult, "renderResult must be registered on the mcp tool");
      const comp = binding.tool.renderResult!(
        makeResult("some result"),
        { expanded: false, isPartial: false },
        testTheme,
        makeRenderCtx({ action: "status" }),
      );
      assert.deepEqual(comp.render(120), [], "collapsed renderResult must render no lines");
    });
  });

  // ---- lifecycle/broker tests (preserved from prior plan) -------------------

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
    const status = await binding.tool.execute("id", { action: "status" }, undefined, undefined, context(cwd));
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
    const restartStatus = await restartBinding.tool.execute("id", { action: "status" }, undefined, undefined, context(restartCwd));
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
