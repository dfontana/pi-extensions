import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fakeRpcSpawn, type FakeRpcChild } from "./fake-rpc.ts";
import { createSubagentExtension } from "./index.ts";
import { SUBAGENT_CHILD_ENV } from "./launch.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-vibe-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

interface ChildState {
  sessionId: string;
  sessionFile: string;
  running: boolean;
}

/** Fake Pi RPC children with real session files, so resume checks run for real. */
function workerProcesses(options: { hold?: boolean } = {}) {
  const state = new WeakMap<FakeRpcChild, ChildState>();
  const finish = (child: FakeRpcChild, reply = "worker report") => {
    state.get(child)!.running = false;
    child.finishRun(reply);
  };
  const fake = fakeRpcSpawn({
    onSpawn: (child, _command, args) => {
      const resumeFile = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
      const sessionId = resumeFile
        ? JSON.parse(readFileSync(resumeFile, "utf8").split("\n")[0]).id
        : args[args.indexOf("--session-id") + 1];
      const directory = args.includes("--session-dir") ? args[args.indexOf("--session-dir") + 1] : root;
      state.set(child, { sessionId, sessionFile: resumeFile ?? join(directory, `${sessionId}.jsonl`), running: false });
    },
    handler: (child, command) => {
      const current = state.get(child)!;
      if (command.type === "<eof>") return child.close(0);
      if (command.type === "get_state") {
        return child.respond(command, { sessionId: current.sessionId, sessionFile: current.sessionFile, isStreaming: current.running, pendingMessageCount: 0 });
      }
      if (command.type !== "prompt") return child.respond(command, {});
      mkdirSync(join(current.sessionFile, ".."), { recursive: true });
      if (!existsSync(current.sessionFile)) writeFileSync(current.sessionFile, `${JSON.stringify({ type: "session", id: current.sessionId })}\n`);
      child.respond(command, { disposition: current.running ? "queued" : "started" });
      current.running = true;
      child.userMessage(command.message);
      if (!options.hold) finish(child);
    },
  });
  return { ...fake, finish };
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function setup(options: { sessionId?: string; processes?: ReturnType<typeof workerProcesses>; mode?: string } = {}) {
  const processes = options.processes ?? workerProcesses();
  const agentsDirectory = mkdtempSync(join(root, "agents-"));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const sent: any[] = [];
  let active = ["read", "bash", "edit", "write", "subagent"];
  let editor: unknown;
  const notices: string[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    getAllTools: () => [...["read", "bash", "edit", "write"].map((name) => ({ name })), ...[...tools.keys()].map((name) => ({ name }))],
    sendMessage: async (message: any, delivery: any) => { sent.push({ message, delivery }); },
  } as unknown as ExtensionAPI;
  const model = { provider: "p", id: "m", name: "m", api: "x", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 10 };
  const ctx = {
    mode: options.mode ?? "tui",
    cwd: root,
    model,
    thinkingLevel: "off",
    scopedModels: [],
    isIdle: () => true,
    modelRegistry: { refresh: async () => ({}), getAvailable: () => [model] },
    sessionManager: { getSessionId: () => options.sessionId ?? "parent-1" },
    ui: {
      theme,
      notify: (message: string) => notices.push(message),
      setStatus() {},
      setWidget() {},
      getEditorComponent: () => editor,
      setEditorComponent: (factory: unknown) => { editor = factory; },
    },
  } as any;
  const previous = process.env[SUBAGENT_CHILD_ENV];
  delete process.env[SUBAGENT_CHILD_ENV];
  createSubagentExtension({
    agentsDirectory,
    vibe: { workersRoot: join(root, "workers"), hooks: { spawn: processes.spawn, shutdownGraceMs: 0, escalationDelayMs: 0 } },
  })(pi);
  if (previous !== undefined) process.env[SUBAGENT_CHILD_ENV] = previous;

  const emit = async (event: string, payload: any = {}) => {
    let result;
    for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
    return result;
  };
  const tool = (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute("call", params, signal, undefined, ctx);
  const toggle = () => commands.get("vibe").handler("", ctx);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { processes, tools, active: () => active, editor: () => editor, sent, notices, emit, tool, toggle, settle, ctx };
}

describe("subagent vibe", () => {
  it("toggles the director toolset, prompt, and editor decoration", async () => {
    const vibe = setup({ sessionId: "toggle" });
    await vibe.toggle();
    assert.deepEqual(vibe.active().sort(), ["read", "subagent", "subagent_kill", "subagent_list", "subagent_send", "subagent_wait"]);
    assert.match(vibe.tools.get("subagent").description, /persistent worker/);
    assert.ok(vibe.editor(), "decorated editor installed");
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await vibe.emit("before_agent_start", event);
    assert.match(event.systemPromptOptions.sections.subagent_vibe, /directing worker agents/);

    await vibe.toggle();
    assert.deepEqual(vibe.active(), ["read", "bash", "edit", "write", "subagent"]);
    assert.match(vibe.tools.get("subagent").description, /synchronous/);
    assert.equal(vibe.editor(), undefined);
    const fresh = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await vibe.emit("before_agent_start", fresh);
    assert.equal(fresh.systemPromptOptions.sections.subagent_vibe, undefined);
  });

  it("refuses to start outside the TUI", async () => {
    const vibe = setup({ sessionId: "rpc", mode: "rpc" });
    await vibe.toggle();
    assert.ok(vibe.active().includes("bash"));
    assert.match(vibe.notices.at(-1)!, /only available in the interactive TUI/);
  });

  it("blocks non-director tools, including nested calls, and user shell commands", async () => {
    const vibe = setup({ sessionId: "policy" });
    await vibe.toggle();
    assert.equal((await vibe.emit("tool_call", { toolName: "bash", input: {} }))?.block, true);
    assert.equal((await vibe.emit("tool_call", { toolName: "edit", input: {}, parentToolCallId: "outer" }))?.block, true);
    assert.equal(await vibe.emit("tool_call", { toolName: "read", input: {} }), undefined);
    assert.match((await vibe.emit("user_bash", { command: "ls" }))?.result.output, /disabled in vibe mode/);
    await vibe.toggle();
    assert.equal(await vibe.emit("tool_call", { toolName: "bash", input: {} }), undefined);
  });

  it("spawns a worker that returns at once and reports its turn to the director", async () => {
    const vibe = setup({ sessionId: "deliver" });
    await vibe.toggle();
    const started = await vibe.tool("subagent", { agent: "General", task: "fix the bug" });
    assert.match(started.content[0].text, /Started worker w1-general/);
    await vibe.settle();

    assert.equal(vibe.sent.length, 1);
    assert.equal(vibe.sent[0].message.customType, "subagent-vibe-result");
    assert.deepEqual(vibe.sent[0].delivery, { triggerTurn: true, deliverAs: "steer" });
    assert.match(vibe.sent[0].message.content, /Worker w1-general turn t1 completed\.\n\nworker report/);
    await vibe.toggle();
  });

  it("hands a turn to a pending wait instead of messaging the director", async () => {
    const processes = workerProcesses({ hold: true });
    const vibe = setup({ sessionId: "wait", processes });
    await vibe.toggle();
    await vibe.tool("subagent", { agent: "General", task: "long job" });
    const steered = await vibe.tool("subagent_send", { workerId: "w1-general", message: "also check tests" });
    assert.match(steered.content[0].text, /running turn \(turn t1\)/);

    const waiting = vibe.tool("subagent_wait", {});
    await vibe.settle();
    processes.finish(processes.children[0], "all done");
    const result = await waiting;
    assert.match(result.content[0].text, /Worker w1-general turn t1 completed\.\n\nall done/);
    await vibe.settle();
    assert.equal(vibe.sent.length, 0);

    assert.match((await vibe.tool("subagent_wait", {})).content[0].text, /No worker turn is running/);
    await vibe.toggle();
  });

  it("parks workers on navigation and resumes their own transcript on send", async () => {
    const vibe = setup({ sessionId: "park" });
    await vibe.toggle();
    await vibe.tool("subagent", { agent: "General", task: "first" });
    await vibe.settle();
    await vibe.emit("session_before_tree");
    assert.equal(vibe.processes.children[0].stdinEnded, true);
    assert.match((await vibe.tool("subagent_list", {})).content[0].text, /w1-general \[parked\]/);

    const resumed = await vibe.tool("subagent_send", { workerId: "w1-general", message: "second" });
    assert.match(resumed.content[0].text, /Started a new turn \(turn t2\)/);
    assert.equal(vibe.processes.children.length, 2);
    await vibe.toggle();
  });

  it("recovers saved workers in a new Pi process and resumes them by send", async () => {
    const first = setup({ sessionId: "restart" });
    await first.toggle();
    await first.tool("subagent", { agent: "General", task: "first" });
    await first.settle();
    await first.emit("session_shutdown", { reason: "quit" });

    const second = setup({ sessionId: "restart" });
    await second.toggle();
    assert.match(second.notices.at(-1)!, /1 saved worker parked/);
    const resumed = await second.tool("subagent_send", { workerId: "w1-general", message: "continue" });
    assert.match(resumed.content[0].text, /turn t2/);
    assert.ok(second.processes.children[0].commands.length > 0);
    await second.settle();
    assert.match(second.sent[0].message.content, /turn t2 completed/);
    await second.toggle();
  });

  it("refuses to resume a transcript that belongs to another session", async () => {
    const first = setup({ sessionId: "mismatch" });
    await first.toggle();
    await first.tool("subagent", { agent: "General", task: "first" });
    await first.settle();
    await first.emit("session_shutdown", { reason: "quit" });
    const saved = JSON.parse(readFileSync(join(root, "workers", "mismatch", "workers.json"), "utf8"));
    writeFileSync(saved.workers[0].sessionFile, `${JSON.stringify({ type: "session", id: "someone-else" })}\n`);

    const second = setup({ sessionId: "mismatch" });
    await second.toggle();
    await assert.rejects(second.tool("subagent_send", { workerId: "w1-general", message: "continue" }), /does not match/);
    assert.equal(second.processes.children.length, 0);
  });

  it("kills a worker and forgets every worker when vibe is turned off", async () => {
    const processes = workerProcesses({ hold: true });
    const vibe = setup({ sessionId: "kill", processes });
    await vibe.toggle();
    await vibe.tool("subagent", { agent: "General", task: "one" });
    await vibe.tool("subagent", { agent: "General", task: "two" });
    assert.match((await vibe.tool("subagent_kill", { workerId: "w1-general" })).content[0].text, /Killed w1-general/);
    await assert.rejects(vibe.tool("subagent_send", { workerId: "w1-general", message: "hi" }), /was killed/);

    await vibe.toggle();
    assert.ok(processes.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.equal(existsSync(join(root, "workers", "kill", "workers.json")), false);
  });

  it("caps live workers: rejects when all are busy and parks the least recently used idle one", async () => {
    const processes = workerProcesses({ hold: true });
    const vibe = setup({ sessionId: "capacity", processes });
    await vibe.toggle();
    await Promise.all(Array.from({ length: 8 }, (_, index) => vibe.tool("subagent", { agent: "General", task: `job ${index}` })));
    await assert.rejects(vibe.tool("subagent", { agent: "General", task: "one too many" }), /8 workers are busy/);

    processes.children.forEach((child, index) => setTimeout(() => processes.finish(child), index));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await vibe.tool("subagent", { agent: "General", task: "fits after parking" });
    assert.equal(processes.children[0].stdinEnded, true, "oldest idle worker parked");
    assert.match((await vibe.tool("subagent_list", {})).content[0].text, /w1-general \[parked\]/);
    await vibe.toggle();
  });
});
