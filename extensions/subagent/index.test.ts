import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentExtension, MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./index.ts";
import { SUBAGENT_CHILD_ENV, type AgentResult, type RunRequest, type SubagentRunner } from "./process.ts";
import { emptyTrackedUsage } from "./usage.ts";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => { render(width: number): string[] };
  renderResult?: (...args: any[]) => { render(width: number): string[] };
}

const testTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderContext(state: Record<string, unknown> = {}) {
  return {
    state,
    invalidate() {},
    args: {},
    toolCallId: "render-test",
    lastComponent: undefined,
    cwd: "/tmp",
    isError: false,
  } as any;
}

function definition(frontmatter: string, body = "Agent system prompt") {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function usage(seed: number): Usage {
  return {
    input: seed,
    output: seed + 1,
    cacheRead: seed + 2,
    cacheWrite: seed + 3,
    cacheWrite1h: seed + 4,
    reasoning: seed + 5,
    totalTokens: seed + 6,
    cost: {
      input: seed / 100,
      output: seed / 100 + 0.01,
      cacheRead: seed / 100 + 0.02,
      cacheWrite: seed / 100 + 0.03,
      total: seed / 10,
    },
  };
}

function successful(request: RunRequest, text = `done: ${request.task}`, taskUsage = usage(1)): AgentResult {
  return {
    agent: request.agent.name,
    task: request.task,
    cwd: request.cwd,
    exitCode: 0,
    status: "done",
    stderr: "",
    model: request.model,
    thinking: request.thinking,
    stopReason: "stop",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "test",
        model: request.model ?? "test-model",
        usage: taskUsage,
        stopReason: "stop",
        timestamp: 1,
      },
    ],
    usage: { usage: taskUsage, turns: 1, contextTokens: taskUsage.totalTokens },
  };
}

function setup(options: { files?: Record<string, string>; run?: SubagentRunner; available?: any[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-extension-"));
  for (const [name, content] of Object.entries(
    options.files ?? { "worker.md": definition("name: worker\ndescription: General worker") },
  )) {
    writeFileSync(join(directory, name), content);
  }

  let tool: RegisteredTool | undefined;
  const api = {
    registerTool(value: RegisteredTool) {
      tool = value;
    },
  } as unknown as ExtensionAPI;
  createSubagentExtension({ agentsDirectory: directory, run: options.run })(api);
  assert.ok(tool, "subagent tool registered");

  const warnings: string[] = [];
  let refreshOptions: unknown;
  const current = { provider: "parent-provider", id: "parent-model", name: "parent-model", api: "openai-responses", baseUrl: "https://example.test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 };
  const makeAvailable = (reference: string, index: number) => {
    const slash = reference.indexOf("/");
    const provider = slash === -1 ? `test-${index}` : reference.slice(0, slash);
    const id = slash === -1 ? reference : reference.slice(slash + 1);
    return { ...current, provider, id, name: id };
  };
  const fallbackAvailable = [
    current,
    ...["agent/model", "override/model", "provider/model", "model-1", "model-2", "model-3", "model-4", "model-5", "model-6"].map(makeAvailable),
  ];
  const ctx = {
    cwd: "/parent/worktree",
    model: current,
    thinkingLevel: "medium",
    modelRegistry: {
      refresh: async (options: unknown) => {
        refreshOptions = options;
        return { aborted: false, errors: new Map() };
      },
      getAvailable: () => options.available ?? fallbackAvailable,
    },
    ui: { notify: (message: string) => warnings.push(message) },
  } as any;
  const call = (params: Record<string, unknown>, onUpdate?: (result: unknown) => void) =>
    tool!.execute("call-id", params, undefined, onUpdate, ctx);
  const callWithSignal = (
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (result: unknown) => void,
  ) => tool!.execute("call-id", params, signal, onUpdate, ctx);
  return { tool, call, callWithSignal, warnings, getRefreshOptions: () => refreshOptions };
}

describe("subagent", () => {
  it("registers a single synchronous tool with single and parallel parameters", () => {
    const { tool } = setup();
    assert.equal(tool.name, "subagent");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["agent", "cwd", "model", "task", "tasks", "thinking"]);
    assert.match(tool.description, /worker: General worker/);
    assert.doesNotMatch(tool.description, /chain|project-local|prompt template/i);
  });

  it("passes the tool cancellation signal to registry refresh", async () => {
    const controller = new AbortController();
    const { callWithSignal, getRefreshOptions } = setup({ run: async (request) => successful(request) });

    await callWithSignal({ agent: "worker", task: "cancel-aware refresh" }, controller.signal);

    assert.equal((getRefreshOptions() as { signal?: AbortSignal }).signal, controller.signal);
  });

  it("stops before starting a child when refresh is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const { callWithSignal } = setup({
      run: async (request) => {
        started = true;
        return successful(request);
      },
    });

    await assert.rejects(
      callWithSignal({ agent: "worker", task: "aborted refresh" }, controller.signal),
    );
    assert.equal(started, false);
  });

  it("resolves call overrides before agent defaults before parent defaults", async () => {
    const requests: RunRequest[] = [];
    const run: SubagentRunner = async (request) => {
      requests.push(request);
      return successful(request);
    };
    const { call } = setup({
      files: {
        "configured.md": definition(
          "name: configured\ndescription: Configured\nmodel: agent/model\nthinking: high\ntools: read, grep",
        ),
        "inherited.md": definition("name: inherited\ndescription: Inherited"),
      },
      run,
    });

    await call({ agent: "configured", task: "agent defaults" });
    await call({
      agent: "configured",
      task: "call defaults",
      cwd: "/override/cwd",
      model: "override/model",
      thinking: "low",
    });
    await call({ agent: "configured", task: "model suffix", model: "override/model:high" });
    await call({ agent: "inherited", task: "parent defaults" });

    assert.deepEqual(
      requests.map(({ agent, task, cwd, model, thinking }) => ({
        agent: agent.name,
        tools: agent.tools,
        task,
        cwd,
        model,
        thinking,
      })),
      [
        {
          agent: "configured",
          tools: ["read", "grep"],
          task: "agent defaults",
          cwd: "/parent/worktree",
          model: "agent/model",
          thinking: "high",
        },
        {
          agent: "configured",
          tools: ["read", "grep"],
          task: "call defaults",
          cwd: "/override/cwd",
          model: "override/model",
          thinking: "low",
        },
        {
          agent: "configured",
          tools: ["read", "grep"],
          task: "model suffix",
          cwd: "/parent/worktree",
          model: "override/model",
          thinking: "high",
        },
        {
          agent: "inherited",
          tools: undefined,
          task: "parent defaults",
          cwd: "/parent/worktree",
          model: "parent-provider/parent-model",
          thinking: "medium",
        },
      ],
    );
  });

  it("resolves explicit short model names to canonical active routes", async () => {
    const requests: RunRequest[] = [];
    const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt-5.6-sol", api: "openai-responses", baseUrl: "https://example.test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 };
    const terra = { ...sol, provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" };
    const { call } = setup({ available: [sol, terra], run: async (request) => { requests.push(request); return successful(request); } });
    await call({ agent: "worker", task: "short name", model: "sonnet", thinking: "high" });
    assert.equal(requests[0].model, "anthropic/claude-sonnet-4-6");
    assert.equal(requests[0].thinking, "high");
  });

  it("treats an exact colon-suffixed model ID as identity before parsing thinking", async () => {
    const requests: RunRequest[] = [];
    const exact = {
      provider: "openrouter",
      id: "vendor/model:high",
      name: "vendor/model:high",
      api: "openai-responses",
      baseUrl: "https://example.test",
      reasoning: true,
      thinkingLevelMap: { high: null },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    const { call } = setup({
      available: [exact],
      run: async (request) => {
        requests.push(request);
        return successful(request);
      },
    });

    await call({ agent: "worker", task: "exact colon ID", model: "openrouter/vendor/model:high" });
    assert.equal(requests[0].model, "openrouter/vendor/model:high");
    assert.equal(requests[0].thinking, undefined);
  });

  it("validates every explicit parallel model before starting a child", async () => {
    let started = 0;
    const { call } = setup({ run: async (request) => { started += 1; return successful(request); } });
    await assert.rejects(call({ tasks: [{ agent: "worker", task: "valid", model: "gpt-5.6-sol" }, { agent: "worker", task: "bad", model: "missing" }] }), /not available/);
    assert.equal(started, 0);
  });

  it("runs at most four parallel tasks, preserves order, and aggregates usage", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run: SubagentRunner = async (request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return successful(request, `result ${request.task}`, usage(Number(request.task)));
    };
    const { call } = setup({ run });
    const updates: unknown[] = [];
    const resultPromise = call(
      {
        tasks: Array.from({ length: 6 }, (_, index) => ({
          agent: "worker",
          task: String(index + 1),
          model: `model-${index + 1}`,
          thinking: index % 2 ? "low" : "high",
        })),
      },
      (update) => updates.push(update),
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, MAX_CONCURRENCY);
    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await resultPromise;

    assert.equal(peak, MAX_CONCURRENCY);
    assert.match(result.content[0].text, /\[worker\] completed\n\nresult 1[\s\S]*result 6/);
    assert.ok(updates.length >= 1);
    assert.ok(updates.length < 12, "bursty parallel status changes should be coalesced");
    assert.deepEqual(
      {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        cacheWrite1h: result.usage.cacheWrite1h,
        reasoning: result.usage.reasoning,
        totalTokens: result.usage.totalTokens,
      },
      { input: 21, output: 27, cacheRead: 33, cacheWrite: 39, cacheWrite1h: 45, reasoning: 51, totalTokens: 57 },
    );
    assert.ok(Math.abs(result.usage.cost.total - 2.1) < 1e-12);
  });

  it("falls back to the globally overridable General agent for unknown names", async () => {
    const requests: RunRequest[] = [];
    const { call } = setup({
      files: { "General.md": definition("name: General\ndescription: Custom general", "Custom general prompt") },
      run: async (request) => {
        requests.push(request);
        return successful(request);
      },
    });

    await call({ agent: "does-not-exist", task: "fallback" });
    assert.equal(requests[0].agent.name, "General");
    assert.equal(requests[0].agent.systemPrompt, "Custom general prompt");
  });

  it("reports invalid definitions while continuing with valid agents", async () => {
    const { call, warnings } = setup({
      files: {
        "bad.md": definition("name: bad"),
        "good.md": definition("name: good\ndescription: Good"),
      },
      run: async (request) => successful(request),
    });

    await call({ agent: "good", task: "continue" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skipped 1 invalid agent definition/);
    assert.match(warnings[0], /bad\.md.*name.*description/s);
  });

  it("rejects ambiguous modes and oversized batches", async () => {
    const { call } = setup({
      run: async (request) => ({
        ...successful(request),
        exitCode: 2,
        stderr: "provider unavailable",
        messages: [],
        usage: emptyTrackedUsage(),
      }),
    });

    await assert.rejects(call({ agent: "worker", task: "x", tasks: [{ agent: "worker", task: "y" }] }), /either.*not both/);
    await assert.rejects(
      call({ tasks: Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => ({ agent: "worker", task: "x" })) }),
      /maximum is 8/,
    );
  });

  it("returns failed single runs with call details for custom rendering", async () => {
    const { call } = setup({
      run: async (request) => ({
        ...successful(request, "Partial response"),
        exitCode: 2,
        stderr: "provider unavailable",
        errorMessage: "provider unavailable",
      }),
    });

    const result = await call({ agent: "worker", task: "Inspect failure", cwd: "/custom", model: "provider/model", thinking: "high" });
    assert.equal(result.content[0].text, "provider unavailable");
    assert.deepEqual(
      {
        agent: result.details.results[0].agent,
        task: result.details.results[0].task,
        cwd: result.details.results[0].cwd,
        model: result.details.results[0].model,
        thinking: result.details.results[0].thinking,
        error: result.details.results[0].errorMessage,
      },
      {
        agent: "worker",
        task: "Inspect failure",
        cwd: "/custom",
        model: "provider/model",
        thinking: "high",
        error: "provider unavailable",
      },
    );
  });

  it("caps single output returned to the parent while preserving details", async () => {
    const output = "x".repeat(60 * 1024);
    const { call } = setup({ run: async (request) => successful(request, output) });
    const result = await call({ agent: "worker", task: "large" });
    assert.ok(Buffer.byteLength(result.content[0].text, "utf8") < Buffer.byteLength(output, "utf8"));
    assert.match(result.content[0].text, /Output truncated/);
    assert.equal(result.details.results[0].messages[0].content[0].text, output);
  });

  it("keeps parallel failures as visible per-task results", async () => {
    const { call } = setup({
      run: async (request) =>
        request.task === "fail"
          ? { ...successful(request), exitCode: 1, messages: [], stderr: "boom", usage: emptyTrackedUsage() }
          : successful(request, "ok"),
    });
    const result = await call({ tasks: [{ agent: "worker", task: "pass" }, { agent: "worker", task: "fail" }] });
    assert.match(result.content[0].text, /1\/2 succeeded/);
    assert.match(result.content[0].text, /\[worker\] failed\n\nboom/);
  });
});

describe("subagent render", () => {
  it("renders the single call heading with status, emphasized agent, and muted model metadata", () => {
    const { tool } = setup();
    assert.ok(tool.renderCall);
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<bold>${text}</bold>`,
    };
    const state = { frame: 0, timer: 1 as any };
    const rendered = tool.renderCall!(
      { agent: "Explore", task: "Inspect the project", model: "openai/gpt-5.6-terra", thinking: "medium" },
      theme,
      renderContext(state),
    ).render(240).map((line) => line.trimEnd()).join("\n");
    assert.equal(
      rendered,
      "<toolTitle><bold>subagent</bold></toolTitle> <warning>●</warning> <toolTitle><bold>Explore</bold></toolTitle> <dim>gpt-5.6-terra medium</dim>",
    );
    assert.doesNotMatch(rendered, /openai\/|thinking|Inspect the project/);
  });

  it("orders metadata before task and hides tool calls when collapsed", () => {
    const { tool } = setup();
    assert.ok(tool.renderResult);
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Inspect the project",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "high" as const,
    };
    const item = successful(request, "Final response");
    item.messages[0] = {
      ...item.messages[0],
      content: [
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/file.ts" } },
        { type: "text", text: "Final response" },
      ],
    } as any;
    const result = { content: [{ type: "text", text: "Final response" }], details: { mode: "single", results: [item] } };

    const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, testTheme, renderContext())
      .render(160)
      .map((line) => line.trimEnd())
      .join("\n");
    assert.match(collapsed, /^1 turn.*\nPrompt: Inspect the project\nFinal response/);
    assert.doesNotMatch(collapsed, /read \/tmp\/file\.ts/);

    const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, testTheme, renderContext())
      .render(160)
      .map((line) => line.trimEnd())
      .join("\n");
    assert.match(expanded, /Agent: worker\nModel: provider\/model\nThinking: high\nCwd: \/tmp\nTask: Inspect the project[\s\S]*read \/tmp\/file\.ts[\s\S]*Final response/);
  });

  it("shows truncated task plus error when collapsed and all parameters, partial output, and error when expanded", () => {
    const { tool } = setup();
    const longTask = `Investigate ${"a".repeat(160)}`;
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: longTask,
      cwd: "/custom/path",
      model: "provider/model",
      thinking: "xhigh" as const,
    };
    const item = successful(request, "Partial response");
    item.exitCode = 2;
    item.status = "done";
    item.errorMessage = "provider unavailable";
    const result = { content: [{ type: "text", text: "provider unavailable" }], details: { mode: "single", results: [item] } };

    const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, testTheme, renderContext())
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    assert.match(collapsed, /^1 turn.*\nPrompt: Investigate a+…\nprovider unavailable/);
    assert.doesNotMatch(collapsed, /Partial response/);
    assert.ok(collapsed.length < longTask.length + 160);

    const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, testTheme, renderContext())
      .render(240)
      .map((line) => line.trimEnd())
      .join("\n");
    assert.match(expanded, /Agent: worker\nModel: provider\/model\nThinking: xhigh\nCwd: \/custom\/path\nTask: Investigate a{160}/);
    assert.match(expanded, /Partial response[\s\S]*Error: provider unavailable/);
  });

  it("retains the expanded component, shows activity while running, and adds final output only on completion", () => {
    const { tool } = setup();
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Work",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "low" as const,
    };
    const item = successful(request, "Intermediate response");
    item.exitCode = -1;
    item.status = "running";
    item.messages[0] = {
      ...item.messages[0],
      content: [
        { type: "text", text: "Intermediate response" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/file.ts" } },
      ],
    } as any;
    const state = {};
    const firstContext = renderContext(state);
    const partialResult = { content: [{ type: "text", text: "Intermediate response" }], details: { mode: "single", results: [item] } };
    const component = tool.renderResult!(partialResult, { expanded: true, isPartial: true }, testTheme, firstContext);
    const running = component.render(160).map((line) => line.trimEnd()).join("\n");
    assert.match(running, /read \/tmp\/file\.ts[\s\S]*\(working…\)/);
    assert.doesNotMatch(running, /Intermediate response/);

    item.exitCode = 0;
    item.status = "done";
    item.messages.push({
      ...item.messages[0],
      content: [{ type: "text", text: "Final response" }],
    } as any);
    const completeResult = { content: [{ type: "text", text: "Final response" }], details: { mode: "single", results: [item] } };
    const completeContext = { ...renderContext(state), lastComponent: component };
    const retained = tool.renderResult!(completeResult, { expanded: true, isPartial: false }, testTheme, completeContext);
    const completed = retained.render(160).map((line) => line.trimEnd()).join("\n");
    assert.equal(retained, component);
    assert.match(completed, /read \/tmp\/file\.ts[\s\S]*Final response/);
    assert.doesNotMatch(completed, /Intermediate response|working/);
  });

  it("renders retained tool activity after its source messages leave the transcript", () => {
    const { tool } = setup();
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Work",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "low" as const,
    };
    const item = successful(request, "Final response");
    item.toolCalls = ["read /tmp/early.ts", "grep /later/ in /tmp"];
    item.omittedToolCalls = 3;
    const rendered = tool.renderResult!(
      { content: [{ type: "text", text: "Final response" }], details: { mode: "single", results: [item] } },
      { expanded: true, isPartial: false },
      testTheme,
      renderContext(),
    ).render(160).map((line) => line.trimEnd()).join("\n");

    assert.match(rendered, /read \/tmp\/early\.ts[\s\S]*grep \/later\/ in \/tmp/);
    assert.match(rendered, /3 later tool calls omitted/);
  });

  it("defers call-heading invalidation until after result rendering", async () => {
    const { tool } = setup();
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Work",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "low" as const,
    };
    const item = successful(request, "Working");
    item.exitCode = -1;
    item.status = "running";
    const state = {};
    let rendering = true;
    let synchronous = false;
    let invalidations = 0;
    const context = {
      ...renderContext(state),
      invalidate() {
        invalidations++;
        if (rendering) synchronous = true;
      },
    };

    tool.renderResult!(
      { content: [{ type: "text", text: "Working" }], details: { mode: "single", results: [item] } },
      { expanded: false, isPartial: true },
      testTheme,
      context,
    );
    rendering = false;

    assert.equal(synchronous, false);
    assert.equal(invalidations, 0);
    await Promise.resolve();
    assert.equal(invalidations, 1);
  });

  it("reports queued parallel tasks as unfinished in expanded progress", () => {
    const { tool } = setup();
    const results = Array.from({ length: 6 }, (_, index) => {
      const item = successful({
        agent: { name: `worker-${index}`, description: "Worker", systemPrompt: "", filePath: "test" },
        task: `Task ${index}`,
        cwd: "/tmp",
      });
      item.exitCode = -1;
      item.status = index < 4 ? "running" : "queued";
      item.messages = [];
      return item;
    });
    const rendered = tool.renderResult!(
      { content: [{ type: "text", text: "running" }], details: { mode: "parallel", results } },
      { expanded: true, isPartial: true },
      testTheme,
      renderContext(),
    ).render(160).map((line) => line.trimEnd()).join("\n");

    assert.match(rendered, /^● parallel 0\/6 finished/);
    assert.match(rendered, /\(queued…\)/);
  });

  it("does not promote an earlier response when the completed final response is empty", () => {
    const { tool } = setup();
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Work",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "low" as const,
    };
    const item = successful(request, "Intermediate response");
    item.messages.push({ ...item.messages[0], content: [] } as any);
    const rendered = tool.renderResult!(
      { content: [{ type: "text", text: "(no output)" }], details: { mode: "single", results: [item] } },
      { expanded: true, isPartial: false },
      testTheme,
      renderContext(),
    ).render(160).map((line) => line.trimEnd()).join("\n");

    assert.match(rendered, /\(no output\)/);
    assert.doesNotMatch(rendered, /Intermediate response/);
  });

  it("updates the single call heading from running marker to checkmark", () => {
    const { tool } = setup();
    const request = {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Work",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "low" as const,
    };
    const item = successful(request, "Working");
    item.exitCode = -1;
    item.status = "running";
    const state = { frame: 0, timer: 1 as any };
    const partialResult = { content: [{ type: "text", text: "Working" }], details: { mode: "single", results: [item] } };
    tool.renderResult!(partialResult, { expanded: false, isPartial: true }, testTheme, renderContext(state)).render(120);
    const partialCall = tool.renderCall!({ agent: "worker", task: "Work" }, testTheme, renderContext(state))
      .render(120).map((line) => line.trimEnd()).join("\n");
    assert.equal(partialCall, "subagent ● worker model low");

    item.exitCode = 0;
    item.status = "done";
    const completeResult = { content: [{ type: "text", text: "Working" }], details: { mode: "single", results: [item] } };
    tool.renderResult!(completeResult, { expanded: false, isPartial: false }, testTheme, renderContext(state)).render(120);
    const completeCall = tool.renderCall!({ agent: "worker", task: "Work" }, testTheme, renderContext(state))
      .render(120).map((line) => line.trimEnd()).join("\n");
    assert.equal(completeCall, "subagent ✓ worker model low");
  });
});

describe("subagent child isolation", () => {
  it("does not register the tool inside spawned child sessions", () => {
    const previous = process.env[SUBAGENT_CHILD_ENV];
    process.env[SUBAGENT_CHILD_ENV] = "1";
    try {
      let registrations = 0;
      createSubagentExtension()({ registerTool: () => registrations++ } as unknown as ExtensionAPI);
      assert.equal(registrations, 0);
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_CHILD_ENV];
      else process.env[SUBAGENT_CHILD_ENV] = previous;
    }
  });
});
