import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createChildSession,
  hasDurableUserPrompt,
  inspectChildSession,
  inspectSnapshotChildSession,
  loadVisibleSnapshots,
  locateToolOrigin,
  parseSessionFileStrict,
  taskEnvelope,
  terminalSnapshotFromInspection,
} from "./persistence.ts";
import { isSnapshot, publicError, type PersistedRunSnapshot } from "./contracts.ts";

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-state-")); }

function snapshot(status: PersistedRunSnapshot["status"]): PersistedRunSnapshot {
  return {
    version: 1, agentId: "a", runId: "r", runNumber: 1, agentOriginEntryId: "origin",
    runOriginEntryId: "origin", parentSessionId: "parent", parentSessionFile: "/parent.jsonl", childSessionId: "child", type: "Explore",
    displayName: "Explore", description: "find", prompt: "find", systemPrompt: "prompt", cwd: "/tmp",
    tools: ["read"], modelRequest: { source: "parent" }, resolvedModel: { provider: "p", id: "m" },
    thinking: "high", background: true, status, startedAt: new Date(0).toISOString(), resultConsumed: false,
    notificationPending: false, notificationSent: false,
  };
}

describe("process-subagents persistence", () => {
  test("precreates a valid header-only child session for durable first prompts", () => {
    const dir = tempDir();
    try {
      const child = createChildSession(dir, dir, "11111111-1111-4111-8111-111111111111", "/parent.jsonl");
      assert.equal(child.sessionId, "11111111-1111-4111-8111-111111111111");
      const entries = parseSessionFileStrict(child.sessionFile);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].type, "session");
      assert.equal((entries[0] as any).parentSession, "/parent.jsonl");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects a valid session file whose identity does not match the snapshot", () => {
    const dir = tempDir();
    try {
      const child = createChildSession(dir, dir, "22222222-2222-4222-8222-222222222222", "/parent.jsonl");
      const state = { ...snapshot("interrupted"), childSessionFile: child.sessionFile, childSessionId: "different", cwd: dir };
      assert.throws(() => inspectSnapshotChildSession(state), /header does not match/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("strictly rejects malformed or non-LF session records", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "bad.jsonl");
      fs.writeFileSync(file, "not json\n");
      assert.throws(() => parseSessionFileStrict(file), /invalid JSON on line 1/);
      fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "x", timestamp: "now", cwd: dir })}\n\n`);
      assert.throws(() => parseSessionFileStrict(file), /blank line 2/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("verifies the exact durable task envelope and reconstructs terminal usage", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "child.jsonl");
      const envelope = taskEnvelope("do work");
      const records = [
        { type: "session", version: 3, id: "child", timestamp: new Date(0).toISOString(), cwd: dir },
        { type: "message", id: "u", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: envelope, timestamp: 1 } },
        { type: "message", id: "a", parentId: "u", timestamp: new Date(2).toISOString(), message: {
          role: "assistant", content: [{ type: "text", text: "done" }], api: "x", provider: "p", model: "m",
          usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 } },
          stopReason: "stop", timestamp: 2,
        } },
      ];
      fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      assert.equal(hasDurableUserPrompt(file, envelope), true);
      assert.equal(hasDurableUserPrompt(file, taskEnvelope("different")), false);
      assert.equal(hasDurableUserPrompt(file, envelope, "a"), false, "historical identical prompts must not satisfy a new run");
      fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "u2", parentId: "a", timestamp: new Date(3).toISOString(), message: { role: "user", content: envelope, timestamp: 3 } })}\n`);
      assert.equal(hasDurableUserPrompt(file, envelope, "a"), true);
      const inspected = inspectChildSession(file);
      assert.equal(inspected.terminal, true);
      assert.equal(inspected.result, "done");
      assert.equal(inspected.usage?.total, 18);
      assert.equal(inspected.cost, 0.2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("recovers an unowned aborted child run as interrupted, not completed", () => {
    const state = { ...snapshot("running"), acceptedPromptEntryId: "u" };
    const recovered = terminalSnapshotFromInspection(state, {
      header: { type: "session", id: "child", timestamp: "now", cwd: "/tmp" }, entries: [], terminal: true,
      failed: false, aborted: true, stopReason: "aborted",
    });
    assert.equal(recovered.status, "interrupted");
  });

  test("locates the persisted assistant entry containing the parallel tool call ID", () => {
    const entries = [
      { type: "message", id: "assistant", parentId: null, timestamp: "now", message: {
        role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "Agent", arguments: {} }],
      } },
    ] as SessionEntry[];
    const manager = { getBranch: () => entries } as unknown as ExtensionContext["sessionManager"];
    assert.equal(locateToolOrigin(manager, "tc-2"), "assistant");
    assert.throws(() => locateToolOrigin(manager, "missing"), /Cannot locate/);
  });

  test("redacts common credential forms from curated public errors", () => {
    const redacted = publicError('Authorization: Bearer sk-live {"apiKey":"json-secret"} https://user:pass@example.test');
    assert.doesNotMatch(redacted, /sk-live|json-secret|user:pass/);
  });

  test("rejects malformed persisted snapshot enums and nested route fields", () => {
    assert.equal(isSnapshot({ ...snapshot("running"), status: "bogus" }), false);
    assert.equal(isSnapshot({ ...snapshot("running"), resolvedModel: undefined }), false);
    assert.equal(isSnapshot(snapshot("running")), true);
  });

  test("takes the latest valid full snapshot visible on the active branch", () => {
    const first = snapshot("running");
    const last = { ...first, status: "completed" as const, completedAt: new Date(1).toISOString() };
    const branch = [
      { type: "custom", customType: "process-subagents:v1", data: first, id: "1", parentId: null, timestamp: "0" },
      { type: "custom", customType: "other", data: {}, id: "2", parentId: "1", timestamp: "1" },
      { type: "custom", customType: "process-subagents:v1", data: last, id: "3", parentId: "2", timestamp: "2" },
    ] as SessionEntry[];
    const manager = { getBranch: () => branch } as unknown as ExtensionContext["sessionManager"];
    assert.equal(loadVisibleSnapshots(manager).get("a:r")?.status, "completed");
  });
});
