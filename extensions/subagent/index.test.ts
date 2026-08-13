import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerSubagentEnvironmentProvider } from "./environment.ts";
import { createSubagentExtension, MAX_ACTIVE_CHILDREN, MAX_OUTSTANDING_CALLS } from "./index.ts";
import { SUBAGENT_CHILD_ENV, type AgentResult, type RunRequest, type SubagentRunner } from "./process.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown>; required?: string[] };
  prepareArguments?: (args: unknown) => unknown;
  executionMode?: "sequential" | "parallel";
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
    lastComponent: undefined,
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

async function eventually(check: () => boolean, message = "condition was not met"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup(options: {
  files?: Record<string, string>;
  run?: SubagentRunner;
  refresh?: (options: { signal: AbortSignal }) => Promise<{ aborted?: boolean }>;
  getAvailable?: () => any[];
  onSpawn?: (environment: Record<string, string>) => void;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-extension-"));
  for (const [name, content] of Object.entries(
    options.files ?? { "worker.md": definition("name: worker\ndescription: General worker") },
  )) {
    writeFileSync(join(directory, name), content);
  }

  let tool: RegisteredTool | undefined;
  let toolResultHandler: ((event: any) => any) | undefined;
  const api = {
    registerTool(value: RegisteredTool) {
      tool = value;
    },
    on(event: string, handler: (value: any) => any) {
      if (event === "tool_result") toolResultHandler = handler;
    },
  } as unknown as ExtensionAPI;
  const previousChildMarker = process.env[SUBAGENT_CHILD_ENV];
  delete process.env[SUBAGENT_CHILD_ENV];
  try {
    const onSpawn = options.onSpawn ?? (() => {});
    registerSubagentEnvironmentProvider("subagent-index-test", () => {
      const environment: Record<string, string> = {};
      onSpawn(environment);
      return environment;
    });
    createSubagentExtension({ agentsDirectory: directory, run: options.run })(api);
  } finally {
    if (previousChildMarker === undefined) delete process.env[SUBAGENT_CHILD_ENV];
    else process.env[SUBAGENT_CHILD_ENV] = previousChildMarker;
  }
  assert.ok(tool, "subagent tool registered");

  const warnings: string[] = [];
  let refreshOptions: { signal?: AbortSignal } | undefined;
  const current = {
    provider: "parent-provider",
    id: "parent-model",
    name: "parent-model",
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
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
      refresh: async (options_: { signal: AbortSignal }) => {
        refreshOptions = options_;
        return options.refresh ? options.refresh(options_) : { aborted: false };
      },
      getAvailable: options.getAvailable ?? (() => fallbackAvailable),
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
  return {
    tool,
    call,
    callWithSignal,
    warnings,
    getRefreshOptions: () => refreshOptions,
    getToolResultHandler: () => toolResultHandler,
  };
}

describe("subagent", () => {
  it("registers the strict single-call schema and sibling-call guidance", () => {
    const { tool } = setup();
    assert.equal(tool.name, "subagent");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["agent", "cwd", "model", "task", "thinking"]);
    assert.deepEqual(tool.parameters.required, ["agent", "task"]);
    assert.equal((tool.parameters as any).additionalProperties, false);
    assert.equal(tool.executionMode, "parallel");
    assert.match(tool.description, /exactly one task/i);
    assert.doesNotMatch(tool.description, /same assistant response|maximum 8|sibling calls/i);
    assert.match(tool.promptGuidelines?.join(" ") ?? "", /same response/i);
    assert.match(tool.promptGuidelines?.join(" ") ?? "", /maximum 8/i);
    assert.doesNotMatch(tool.description, /tasks array/i);
  });

  it("gives targeted migration guidance for legacy tasks input", () => {
    const { tool } = setup();
    assert.throws(
      () => tool.prepareArguments?.({ tasks: [{ agent: "worker", task: "old" }] }),
      /tasks syntax was removed.*sibling subagent call.*same response/i,
    );
  });

  it("passes cancellation to the caller without cancelling a shared refresh for siblings", async () => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refresh = async () => {
      refreshCalls++;
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return { aborted: false };
    };
    const requests: RunRequest[] = [];
    const { callWithSignal, call, getRefreshOptions } = setup({
      refresh,
      run: async (request) => {
        requests.push(request);
        return successful(request);
      },
    });
    const firstController = new AbortController();
    const firstUpdates: any[] = [];
    const first = callWithSignal(
      { agent: "worker", task: "cancel me", model: "provider/model:HIGH" },
      firstController.signal,
      (value) => firstUpdates.push(value),
    );
    const second = call({ agent: "worker", task: "continue" });
    await eventually(() => refreshCalls === 1);
    firstController.abort();
    const cancelled = await first;
    releaseRefresh();
    const completed = await second;

    assert.equal(refreshCalls, 1);
    assert.equal(getRefreshOptions()?.signal?.aborted, false);
    assert.equal(firstUpdates[0].details.result.thinking, "high");
    assert.equal(cancelled.details.result.stopReason, "aborted");
    assert.equal(cancelled.details.result.thinking, "high");
    assert.equal(completed.details.result.status, "done");
    assert.equal(requests.length, 1);
  });

  it("aborts and clears a refresh when every waiter cancels, allowing a later flight", async () => {
    let refreshCalls = 0;
    const refreshSignals: AbortSignal[] = [];
    let releaseLater!: () => void;
    const refresh = ({ signal }: { signal: AbortSignal }) => {
      refreshCalls++;
      refreshSignals.push(signal);
      if (refreshCalls === 1) {
        // Simulate a provider that hangs even after receiving the abort.
        return new Promise<{ aborted?: boolean }>(() => {});
      }
      return new Promise<{ aborted?: boolean }>((resolve) => {
        releaseLater = () => resolve({ aborted: false });
      });
    };
    const { callWithSignal, getRefreshOptions, call } = setup({
      refresh,
      run: async (request) => successful(request),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = callWithSignal({ agent: "worker", task: "cancel first" }, firstController.signal);
    const second = callWithSignal({ agent: "worker", task: "cancel second" }, secondController.signal);
    await eventually(() => refreshCalls === 1);

    firstController.abort();
    secondController.abort();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.details.result.stopReason, "aborted");
    assert.equal(secondResult.details.result.stopReason, "aborted");
    assert.equal(refreshSignals[0].aborted, true);

    const later = call({ agent: "worker", task: "new refresh" });
    await eventually(() => refreshCalls === 2);
    releaseLater();
    await later;
    assert.equal(refreshSignals[1].aborted, false);
    assert.equal(getRefreshOptions()?.signal?.aborted, false);
  });

  it("resolves call overrides before agent defaults before parent defaults", async () => {
    const requests: RunRequest[] = [];
    const run: SubagentRunner = async (request) => {
      requests.push(request);
      return successful(request);
    };
    const { call } = setup({
      files: {
        "configured.md": definition("name: configured\ndescription: Configured\nmodel: agent/model\nthinking: high\ntools: read, grep"),
        "inherited.md": definition("name: inherited\ndescription: Inherited"),
      },
      run,
    });

    await call({ agent: "configured", task: "agent defaults" });
    await call({ agent: "configured", task: "call defaults", cwd: "/override/cwd", model: "override/model", thinking: "low" });
    await call({ agent: "configured", task: "model suffix", model: "override/model:high" });
    await call({ agent: "inherited", task: "parent defaults" });

    assert.deepEqual(
      requests.map(({ agent, task, cwd, model, thinking }) => ({ agent: agent.name, task, cwd, model, thinking })),
      [
        { agent: "configured", task: "agent defaults", cwd: "/parent/worktree", model: "agent/model", thinking: "high" },
        { agent: "configured", task: "call defaults", cwd: "/override/cwd", model: "override/model", thinking: "low" },
        { agent: "configured", task: "model suffix", cwd: "/parent/worktree", model: "override/model", thinking: "high" },
        { agent: "inherited", task: "parent defaults", cwd: "/parent/worktree", model: "parent-provider/parent-model", thinking: "medium" },
      ],
    );
  });

  it("uses an isolated environment snapshot for each sibling launch", async () => {
    const environments: Array<Record<string, string>> = [];
    const requests: RunRequest[] = [];
    const { call } = setup({
      onSpawn(environment) {
        environment.TEST_HANDOFF = String(environments.length + 1);
        environments.push(environment);
      },
      run: async (request) => {
        requests.push(request);
        return successful(request);
      },
    });

    await Promise.all([
      call({ agent: "worker", task: "first" }),
      call({ agent: "worker", task: "second" }),
    ]);

    assert.equal(environments.length, 2);
    assert.notEqual(environments[0], environments[1]);
    assert.deepEqual(requests.map((request) => request.environment), [
      { TEST_HANDOFF: "1" },
      { TEST_HANDOFF: "2" },
    ]);
  });

  it("admits eight calls FIFO, runs four children, and queues every native row", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const requests: RunRequest[] = [];
    const updates = new Map<string, any[]>();
    const { call } = setup({
      run: async (request) => {
        active++;
        peak = Math.max(peak, active);
        requests.push(request);
        return new Promise<AgentResult>((resolve) => {
          releases.push(() => {
            active--;
            resolve(successful(request));
          });
        });
      },
    });

    const calls = Array.from({ length: MAX_OUTSTANDING_CALLS }, (_, index) => {
      const task = String(index);
      const values: any[] = [];
      updates.set(task, values);
      return call({ agent: "worker", task }, (value) => values.push(value));
    });
    await assert.rejects(call({ agent: "worker", task: "excess" }), /Too many outstanding/);
    await eventually(() => requests.length === MAX_ACTIVE_CHILDREN);
    assert.equal(active, MAX_ACTIVE_CHILDREN);
    assert.equal(peak, MAX_ACTIVE_CHILDREN);
    for (const values of updates.values()) {
      assert.equal(values[0].details.result.status, "queued");
    }

    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(calls);
    assert.deepEqual(requests.map((request) => request.task), Array.from({ length: 8 }, (_, index) => String(index)));
  });

  it("releases a lease when cancellation lands between grant and continuation", async () => {
    let runs = 0;
    let abortQueued = false;
    const controller = new AbortController();
    const { callWithSignal, call } = setup({
      run: async (request) => {
        runs++;
        return successful(request);
      },
    });
    const cancelled = await callWithSignal(
      { agent: "worker", task: "abort after grant" },
      controller.signal,
      (value: any) => {
        // The resolved model only appears in the setup update immediately
        // before acquire(). Queue abort so it runs after acquire grants but
        // before the await continuation resumes.
        if (value.details?.result?.model && !abortQueued) {
          abortQueued = true;
          queueMicrotask(() => controller.abort());
        }
      },
    );
    assert.equal(cancelled.details.result.stopReason, "aborted");
    assert.equal(runs, 0);

    const calls = Array.from({ length: MAX_ACTIVE_CHILDREN }, (_, index) =>
      call({ agent: "worker", task: `after-${index}` }),
    );
    await eventually(() => runs === MAX_ACTIVE_CHILDREN, "a released lease did not admit every follow-up call");
    await Promise.all(calls);
  });

  it("removes an aborted waiter without launching it", async () => {
    const releases: Array<() => void> = [];
    const requests: RunRequest[] = [];
    const controller = new AbortController();
    const { call, callWithSignal } = setup({
      run: async (request) => {
        requests.push(request);
        return new Promise<AgentResult>((resolve) => releases.push(() => resolve(successful(request))));
      },
    });
    const calls = Array.from({ length: 4 }, (_, index) => call({ agent: "worker", task: `active-${index}` }));
    const waiter = callWithSignal({ agent: "worker", task: "never-start", }, controller.signal);
    await eventually(() => requests.length === 4);
    controller.abort();
    const cancelled = await waiter;
    assert.equal(cancelled.details.result.stopReason, "aborted");
    assert.equal(requests.some((request) => request.task === "never-start"), false);
    while (releases.length) releases.shift()!();
    await Promise.all(calls);
  });

  it("releases slots after runner and setup failures", async () => {
    let runs = 0;
    const { call } = setup({
      run: async (request) => {
        runs++;
        if (runs === 1) throw new Error("runner setup failed");
        return successful(request);
      },
    });
    await assert.rejects(call({ agent: "worker", task: "throws" }), /runner setup failed/);
    await call({ agent: "worker", task: "after" });
    assert.equal(runs, 2);

    let reads = 0;
    const setupFailure = setup({
      getAvailable: () => {
        reads++;
        if (reads === 1) throw new Error("registry setup failed");
        return [];
      },
      run: async (request) => successful(request),
    });
    await assert.rejects(setupFailure.call({ agent: "worker", task: "bad setup" }), /registry setup failed/);
    await setupFailure.call({ agent: "worker", task: "recovered" });
    assert.equal(reads, 2);
  });

  it("lets one invalid model row fail while a sibling resolves and runs", async () => {
    const requests: RunRequest[] = [];
    const { call } = setup({ run: async (request) => { requests.push(request); return successful(request); } });
    const bad = call({ agent: "worker", task: "bad", model: "missing-model" });
    const good = call({ agent: "worker", task: "good" });
    await assert.rejects(bad, /not available/);
    await good;
    assert.deepEqual(requests.map((request) => request.task), ["good"]);
  });

  it("keeps child failure details and usage while the native handler marks isError", async () => {
    const { call, getToolResultHandler } = setup({
      run: async (request) => ({
        ...successful(request, "partial", usage(7)),
        exitCode: 2,
        stderr: "provider unavailable",
        errorMessage: "provider unavailable",
      }),
    });
    const result = await call({ agent: "worker", task: "failure" });
    assert.equal(result.content[0].text, "provider unavailable");
    assert.equal(result.details.result.errorMessage, "provider unavailable");
    assert.deepEqual(Object.keys(result.details), ["result"]);
    assert.equal(result.usage.totalTokens, usage(7).totalTokens);
    assert.deepEqual(
      getToolResultHandler()?.({ toolName: "subagent", details: result.details }),
      { isError: true },
    );
    assert.equal(getToolResultHandler()?.({
      toolName: "subagent",
      details: { result: { ...result.details.result, status: "running" } },
    }), undefined);
  });

  it("falls back to General and deduplicates repeated diagnostics", async () => {
    const requests: RunRequest[] = [];
    const { call, warnings } = setup({
      files: {
        "bad.md": definition("name: bad"),
        "General.md": definition("name: General\ndescription: Custom general", "Custom general prompt"),
      },
      run: async (request) => { requests.push(request); return successful(request); },
    });
    await Promise.all([
      call({ agent: "unknown", task: "first" }),
      call({ agent: "unknown", task: "second" }),
    ]);
    assert.equal(requests[0].agent.name, "General");
    assert.equal(requests[0].agent.systemPrompt, "Custom general prompt");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bad\.md/);
  });
});

describe("subagent render", () => {
  function request(): RunRequest {
    return {
      agent: { name: "worker", description: "Worker", systemPrompt: "", filePath: "test" },
      task: "Inspect the project",
      cwd: "/tmp",
      model: "provider/model",
      thinking: "high",
    };
  }

  it("renders queued, running, success, and failure states in one native row", () => {
    const { tool } = setup();
    assert.ok(tool.renderCall && tool.renderResult);
    const queued = successful(request(), "queued");
    queued.exitCode = -1;
    queued.status = "queued";
    queued.messages = [];
    const state = {};
    const queuedResult = { content: [{ type: "text", text: "waiting" }], details: { result: queued } };
    const queuedHeading = tool.renderCall!({ agent: "worker", task: queued.task }, testTheme, renderContext(state)).render(120).join("\n");
    assert.match(queuedHeading, /subagent · worker/);
    const queuedBody = tool.renderResult!(queuedResult, { expanded: false, isPartial: true }, testTheme, renderContext(state)).render(120).join("\n");
    assert.match(queuedBody, /waiting for subagent slot/);

    const running = { ...queued, status: "running" as const };
    const runningResult = { ...queuedResult, details: { ...queuedResult.details, result: running } };
    const runningBody = tool.renderResult!(runningResult, { expanded: false, isPartial: true }, testTheme, renderContext(state)).render(120).join("\n");
    assert.match(runningBody, /working…/);

    const complete = successful(request(), "Final response");
    const completeResult = { content: [{ type: "text", text: "Final response" }], details: { result: complete } };
    const completeBody = tool.renderResult!(completeResult, { expanded: false, isPartial: false }, testTheme, renderContext(state)).render(120).join("\n");
    assert.match(completeBody, /Final response/);
    const successHeading = tool.renderCall!({ agent: "worker", task: complete.task }, testTheme, renderContext(state)).render(120).join("\n");
    assert.match(successHeading, /✓ worker/);
  });

  it("uses canonical case-insensitive thinking suffix metadata in queued headings", () => {
    const { tool } = setup();
    assert.ok(tool.renderCall);
    const heading = tool.renderCall!(
      { agent: "worker", task: "queued", model: "provider/model:HIGH" },
      testTheme,
      renderContext(),
    ).render(120).join("\n");
    assert.match(heading, /model high/);
  });

  it("marks native setup and runner errors as failed headings, including replayed rows", () => {
    const { tool } = setup();
    assert.ok(tool.renderCall && tool.renderResult);

    const directHeading = tool.renderCall!(
      { agent: "worker", task: "setup" },
      testTheme,
      { ...renderContext({}), isError: true },
    ).render(120).join("\n");
    assert.match(directHeading, /✗ worker/);

    const queued = successful(request(), "queued");
    queued.exitCode = -1;
    queued.status = "queued";
    queued.messages = [];
    for (const message of [
      { text: "registry setup failed", details: undefined },
      { text: "model resolution failed", details: undefined },
      { text: "admission failed", details: undefined },
      { text: "runner failed", details: { result: queued } },
    ]) {
      const state = {};
      const rendered = tool.renderResult!(
        { content: [{ type: "text", text: message.text }], details: message.details },
        { expanded: false, isPartial: false },
        testTheme,
        { ...renderContext(state), isError: true },
      ).render(120).join("\n");
      assert.match(rendered, new RegExp(message.text));
      const heading = tool.renderCall!(
        { agent: "worker", task: "replay" },
        testTheme,
        { ...renderContext(state), isError: true },
      ).render(120).join("\n");
      assert.match(heading, /✗ worker/);
    }
  });

  it("keeps expanded activity fixed at ten lines and clears it on completion", () => {
    const { tool } = setup();
    assert.ok(tool.renderResult);
    const item = successful(request(), "Intermediate response");
    item.exitCode = -1;
    item.status = "running";
    item.messages[0] = { ...item.messages[0], content: [{ type: "text", text: "Intermediate response" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/old.ts" } }] } as any;
    const state = {};
    const partial = { content: [{ type: "text", text: "running" }], details: { result: item } };
    const component = tool.renderResult!(partial, { expanded: true, isPartial: true }, testTheme, renderContext(state));
    const width = 40;
    const noCall = component.render(width);
    const noCallText = noCall.join("\n");
    assert.ok(noCall.length >= 10);
    assert.equal(noCall[0].trimEnd(), "Cwd: /tmp");
    assert.doesNotMatch(noCallText, /Parameters|Agent:|Model:|Thinking:|old\.ts/);

    const queuedItem = { ...item, status: "queued" as const, exitCode: -1, messages: [], latestToolCall: "read /tmp/queued.ts" };
    const queuedComponent = tool.renderResult!({ content: [{ type: "text", text: "waiting" }], details: { result: queuedItem } }, { expanded: true, isPartial: true }, testTheme, renderContext({}));
    const queuedLines = queuedComponent.render(width);
    assert.ok(queuedLines.length < noCall.length);
    assert.doesNotMatch(queuedLines.join("\n"), /queued\.ts/);

    item.latestToolCall = `read {\n  "path": "/tmp/new.ts",\n  "offset": 25,\n  "limit": 100\n}`;
    const shortCall = tool.renderResult!(partial, { expanded: true, isPartial: true }, testTheme, { ...renderContext(state), lastComponent: component });
    assert.equal(shortCall, component);
    const shortLines = component.render(width);
    const shortText = shortLines.join("\n");
    assert.equal(shortLines.length, noCall.length);
    assert.match(shortText, /new\.ts/);
    assert.match(shortText, /"offset": 25/);
    assert.match(shortText, /"limit": 100/);
    assert.doesNotMatch(shortText, /old\.ts/);

    item.latestToolCall = `custom {\n  "payload": "${"x".repeat(1_000)}",\n  "after": "not visible"\n}`;
    const longCall = tool.renderResult!(partial, { expanded: true, isPartial: true }, testTheme, { ...renderContext(state), lastComponent: component });
    assert.equal(longCall, component);
    const longLines = component.render(width);
    assert.equal(longLines.length, noCall.length);
    assert.ok(longLines.every((line) => visibleWidth(line) <= width));
    assert.ok(longLines.some((line) => line.includes("…")), "clipped preview marks omitted lines");
    assert.doesNotMatch(longLines.join("\n"), /not visible/);

    item.latestToolCall = "grep /newest/ in /tmp";
    tool.renderResult!(partial, { expanded: true, isPartial: true }, testTheme, { ...renderContext(state), lastComponent: component });
    const changingLines = component.render(width);
    assert.equal(changingLines.length, noCall.length);
    assert.match(changingLines.join("\n"), /newest/);
    assert.doesNotMatch(changingLines.join("\n"), /custom|new\.ts|old\.ts/);

    item.exitCode = 0;
    item.status = "done";
    item.messages.push({ ...item.messages[0], content: [{ type: "text", text: "Final response" }] } as any);
    const complete = tool.renderResult!({ content: [{ type: "text", text: "Final response" }], details: { result: item } }, { expanded: true, isPartial: false }, testTheme, { ...renderContext(state), lastComponent: component });
    assert.equal(complete, component);
    const completedLines = complete.render(width);
    const completedText = completedLines.join("\n");
    assert.equal(noCall.length - completedLines.length, 10);
    assert.match(completedText, /Final response/);
    assert.doesNotMatch(completedText, /grep|custom|new\.ts|old\.ts/);

    for (const [status, errorMessage] of [[1, "failed"], [130, "Subagent was aborted"]] as const) {
      const failed = { ...item, exitCode: status, status: "done" as const, stopReason: status === 130 ? "aborted" : "error", errorMessage, latestToolCall: "read /tmp/finished.ts" };
      const failedComponent = tool.renderResult!({ content: [{ type: "text", text: errorMessage }], details: { result: failed } }, { expanded: true, isPartial: false }, testTheme, renderContext({}));
      const failedText = failedComponent.render(width).join("\n");
      assert.ok(failedComponent.render(width).length < noCall.length);
      assert.doesNotMatch(failedText, /finished\.ts|grep|custom/);
      assert.match(failedText, new RegExp(errorMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("leaves collapsed rendering independent of expanded activity", () => {
    const { tool } = setup();
    assert.ok(tool.renderResult);
    const item = successful(request(), "Final response");
    const state = {};
    const base = tool.renderResult!({ content: [{ type: "text", text: "Final response" }], details: { result: item } }, { expanded: false, isPartial: false }, testTheme, renderContext(state)).render(120).join("\n");
    item.latestToolCall = "read /tmp/history.ts";
    const withActivity = tool.renderResult!({ content: [{ type: "text", text: "Final response" }], details: { result: item } }, { expanded: false, isPartial: false }, testTheme, { ...renderContext(state), lastComponent: undefined }).render(120).join("\n");
    assert.equal(withActivity, base);
  });

  it("renders legacy single details through the current renderer and parallel details as raw fallback", () => {
    const { tool } = setup();
    assert.ok(tool.renderCall && tool.renderResult);
    const item = successful(request(), "Legacy final");
    const oldSingle = { mode: "single", agentsDirectory: "/tmp", diagnostics: [], results: [item] };
    const single = tool.renderResult!({ content: [{ type: "text", text: "Legacy final" }], details: oldSingle }, { expanded: false, isPartial: false }, testTheme, renderContext()).render(120).join("\n");
    assert.match(single, /Legacy final/);

    const oldParallel = { mode: "parallel", results: [item, { ...item, task: "second" }] };
    const batch = tool.renderResult!({ content: [{ type: "text", text: "old" }], details: oldParallel }, { expanded: false, isPartial: false }, testTheme, renderContext()).render(120).join("\n");
    assert.equal(batch.trimEnd(), "old");
    const expandedBatch = tool.renderResult!({ content: [{ type: "text", text: "old" }], details: oldParallel }, { expanded: true, isPartial: false }, testTheme, renderContext()).render(120).join("\n");
    assert.match(expandedBatch, /^old/);
    assert.doesNotMatch(expandedBatch, /worker/);
    const heading = tool.renderCall!({ tasks: [{ agent: "worker", task: "old" }] }, testTheme, renderContext({})).render(120).join("\n");
    assert.match(heading, /legacy batch/);
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
