import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PersistedRunSnapshot } from "./contracts.ts";
import { SubagentRuntime } from "./runtime.ts";

function model() {
  return { provider: "p", id: "m", name: "m", api: "fake", baseUrl: "https://example.invalid", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(maxConcurrentAgents: number) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(cwd, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrentAgents }));
  const parentFile = path.join(cwd, "parent.jsonl");
  fs.writeFileSync(parentFile, "");
  let branch: SessionEntry[] = [{
    type: "message", id: "origin", parentId: null, timestamp: new Date().toISOString(), message: {
      role: "assistant", content: [
        { type: "toolCall", id: "call-1", name: "Agent", arguments: { prompt: "work", description: "work", subagent_type: "general-purpose" } },
        { type: "toolCall", id: "call-2", name: "Agent", arguments: {} },
      ], api: "fake", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now(),
    },
  }] as SessionEntry[];
  const auth = deferred<any>();
  const ctx = {
    cwd,
    model: model(),
    isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [model()], getApiKeyAndHeaders: () => auth.promise },
    sessionManager: {
      getSessionFile: () => parentFile,
      getSessionDir: () => cwd,
      getSessionId: () => "parent",
      getBranch: () => branch,
      getEntry: (id: string) => branch.find((entry) => entry.id === id),
    },
  } as unknown as ExtensionContext;
  const pi = {
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", description: "", parameters: {}, sourceInfo: {
      path: "<builtin:read>", source: "builtin", scope: "user", origin: "top-level",
    } }],
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const runtime = new SubagentRuntime(pi);
  return {
    cwd, ctx, auth, runtime,
    getBranch: () => branch,
    setBranch: (entries: SessionEntry[]) => { branch = entries; },
    cleanup: () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const input = { prompt: "work", description: "work", subagent_type: "general-purpose", model: "p/m", thinking: "off" as const };

describe("process-subagents runtime", () => {
  test("atomically reserves the global cap while authentication is pending", async () => {
    const h = harness(1);
    try {
      const first = h.runtime.start("call-1", input, undefined, h.ctx);
      await assert.rejects(h.runtime.start("call-2", input, undefined, h.ctx), /concurrency limit/);
      h.auth.resolve({ ok: false, error: "stop before spawn" });
      await assert.rejects(first, /Authentication.*stop before spawn/);
    } finally { h.cleanup(); }
  });

  test("cancels and awaits pending authentication admission during shutdown", async () => {
    const h = harness(1);
    try {
      const pending = h.runtime.start("call-1", input, undefined, h.ctx);
      await h.runtime.shutdown("reload");
      await assert.rejects(pending, /interrupted by reload/);
      h.auth.resolve({ ok: true });
      assert.equal(h.runtime.runningViews(h.ctx).length, 0);
    } finally { h.cleanup(); }
  });

  test("does not spawn after the originating call leaves the active branch during auth", async () => {
    const h = harness(1);
    try {
      const pending = h.runtime.start("call-1", input, undefined, h.ctx);
      h.setBranch([]);
      h.auth.resolve({ ok: true });
      await assert.rejects(pending, /left the active branch/);
      assert.equal(h.runtime.runningViews(h.ctx).length, 0);
    } finally { h.cleanup(); }
  });

  test("serializes concurrent resume admissions for the same child session", async () => {
    const h = harness(2);
    try {
      const base = h.getBranch()[0];
      const childFile = path.join(h.cwd, "child.jsonl");
      const parentFile = path.join(h.cwd, "parent.jsonl");
      const records = [
        { type: "session", version: 3, id: "child", timestamp: "2020-01-01T00:00:00Z", cwd: h.cwd, parentSession: parentFile },
        { type: "message", id: "u", parentId: null, timestamp: "2020-01-01T00:00:01Z", message: { role: "user", content: "old", timestamp: 1 } },
        { type: "message", id: "a", parentId: "u", timestamp: "2020-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "old result" }], api: "fake", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
      ];
      fs.writeFileSync(childFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const state: PersistedRunSnapshot = {
        version: 1, agentId: "resume-agent", runId: "run-1", runNumber: 1, agentOriginEntryId: "origin", runOriginEntryId: "origin",
        parentSessionId: "parent", parentSessionFile: parentFile, childSessionId: "child", childSessionFile: childFile,
        acceptedPromptEntryId: "u", type: "general-purpose", displayName: "General", description: "work", prompt: "old",
        systemPrompt: "prompt", cwd: h.cwd, tools: ["read"], modelRequest: { source: "parent" }, resolvedModel: { provider: "p", id: "m" },
        thinking: "off", background: false, status: "completed", startedAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-01T00:00:02Z",
        resultConsumed: true, notificationPending: false, notificationSent: false,
      };
      const persisted = { type: "custom", customType: "process-subagents:v1", data: state, id: "state", parentId: "origin", timestamp: "2" } as SessionEntry;
      h.setBranch([base, persisted]);
      await h.runtime.sessionStart(h.ctx);
      const resumeInput = { agent_id: "resume-agent", prompt: "again", model: "p/m", thinking: "off" as const };
      const first = h.runtime.resume("call-1", resumeInput, undefined, h.ctx);
      await assert.rejects(h.runtime.resume("call-2", resumeInput, undefined, h.ctx), /already has a resume starting/);
      h.auth.resolve({ ok: false, error: "stop before spawn" });
      await assert.rejects(first, /Authentication/);
    } finally { h.cleanup(); }
  });

  test("ingests agents first encountered after navigating to another branch", async () => {
    const h = harness(2);
    try {
      const base = h.getBranch()[0];
      await h.runtime.sessionStart(h.ctx);
      const state: PersistedRunSnapshot = {
        version: 1, agentId: "branch-agent", runId: "branch-run", runNumber: 1, agentOriginEntryId: "origin",
        runOriginEntryId: "origin", parentSessionId: "parent", parentSessionFile: path.join(h.cwd, "parent.jsonl"),
        childSessionId: "child", type: "general-purpose", displayName: "General", description: "work", prompt: "work",
        systemPrompt: "prompt", cwd: h.cwd, tools: ["read"], modelRequest: { source: "parent" },
        resolvedModel: { provider: "p", id: "m" }, thinking: "off", background: false, status: "completed",
        startedAt: new Date(1).toISOString(), completedAt: new Date(2).toISOString(), resultConsumed: true,
        notificationPending: false, notificationSent: false, resultPreview: "branch result",
      };
      const persisted = { type: "custom", customType: "process-subagents:v1", data: state, id: "branch-snapshot", parentId: "origin", timestamp: "2" } as SessionEntry;
      h.setBranch([base, persisted]);
      h.runtime.reconcileDirty(h.ctx);
      assert.equal(JSON.parse(await h.runtime.getResult("branch-agent", false, undefined, h.ctx)).runId, "branch-run");
      assert.equal(h.runtime.getRunForToolCall("call-1")?.snapshot.runId, "branch-run", "historical card mapping is rebuilt");
    } finally { h.cleanup(); }
  });

  test("selects the latest run whose run origin is on the active branch", async () => {
    const h = harness(2);
    try {
      const base = h.getBranch()[0];
      const makeSnapshot = (runId: string, runNumber: number, runOriginEntryId: string): PersistedRunSnapshot => ({
        version: 1, agentId: "agent-shared", runId, runNumber, agentOriginEntryId: "origin", runOriginEntryId,
        parentSessionId: "parent", parentSessionFile: path.join(h.cwd, "parent.jsonl"), childSessionId: "child",
        type: "Explore", displayName: "Explore", description: runId, prompt: runId, systemPrompt: "prompt", cwd: h.cwd,
        tools: ["read"], modelRequest: { source: "parent" }, resolvedModel: { provider: "p", id: "m" },
        thinking: "off", background: false, status: "completed", startedAt: new Date(runNumber).toISOString(),
        completedAt: new Date(runNumber + 1).toISOString(), resultConsumed: true, notificationPending: false,
        notificationSent: false, resultPreview: runId,
      });
      const first = makeSnapshot("run-1", 1, "origin");
      const resumeOrigin = { ...base, id: "resume-origin", parentId: "snap-1" } as SessionEntry;
      const second = makeSnapshot("run-2", 2, "resume-origin");
      const snap1 = { type: "custom", customType: "process-subagents:v1", data: first, id: "snap-1", parentId: "origin", timestamp: "1" } as SessionEntry;
      const snap2 = { type: "custom", customType: "process-subagents:v1", data: second, id: "snap-2", parentId: "resume-origin", timestamp: "2" } as SessionEntry;
      h.setBranch([base, snap1, resumeOrigin, snap2]);
      await h.runtime.sessionStart(h.ctx);
      h.setBranch([base, snap1]);
      assert.equal(JSON.parse(await h.runtime.getResult("agent-shared", false, undefined, h.ctx)).runId, "run-1");
      h.setBranch([base, snap1, resumeOrigin, snap2]);
      assert.equal(JSON.parse(await h.runtime.getResult("agent-shared", false, undefined, h.ctx)).runId, "run-2");
    } finally { h.cleanup(); }
  });
});
