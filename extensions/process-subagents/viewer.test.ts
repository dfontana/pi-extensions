import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { PersistedRunSnapshot } from "./contracts.ts";
import { RunningWidget, TranscriptViewer } from "./viewer.ts";

function snapshot(file: string, status: PersistedRunSnapshot["status"] = "running"): PersistedRunSnapshot {
  return {
    version: 1, agentId: "agent-123456789", runId: "run-1", runNumber: 1,
    agentOriginEntryId: "origin", runOriginEntryId: "origin", parentSessionId: "p", parentSessionFile: "/parent.jsonl", childSessionId: "c",
    childSessionFile: file, type: "Explore", displayName: "Explore", description: "Inspect files", prompt: "inspect",
    systemPrompt: "prompt", cwd: process.cwd(), tools: ["custom_tool"], modelRequest: { source: "parent" },
    resolvedModel: { provider: "p", id: "m" }, thinking: "high", background: true, status,
    startedAt: new Date(0).toISOString(), lastActivityAt: new Date().toISOString(), resultConsumed: false,
    notificationPending: false, notificationSent: false,
  };
}

initTheme(undefined, false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
const keybindings = { matches: () => false } as any;

describe("process-subagents viewer", () => {
  test("renders persisted standard messages and generic custom tool fallback with a live overlay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-viewer-"));
    try {
      const file = path.join(dir, "child.jsonl");
      const records = [
        { type: "session", version: 3, id: "c", timestamp: "2020-01-01T00:00:00Z", cwd: process.cwd() },
        { type: "message", id: "u", parentId: null, timestamp: "2020-01-01T00:00:01Z", message: { role: "user", content: "hello", timestamp: 1 } },
        { type: "message", id: "a", parentId: "u", timestamp: "2020-01-01T00:00:02Z", message: {
          role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "tc", name: "custom_tool", arguments: { value: 1 } }],
          api: "x", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2,
        } },
        { type: "message", id: "t", parentId: "a", timestamp: "2020-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: "tc", toolName: "custom_tool", content: [{ type: "text", text: "ok" }], details: { metadata: true }, isError: false, timestamp: 3 } },
        { type: "custom_message", id: "hidden", parentId: "t", timestamp: "2020-01-01T00:00:04Z", customType: "hidden", content: "secret hidden text", display: false },
      ];
      fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const state = snapshot(file);
      const runtime = {
        subscribe: () => () => {},
        getRun: () => ({ snapshot: state, preview: "custom_tool running", liveTools: [], durableRevision: 0 }),
        getRunByIds: () => ({ snapshot: state, preview: "custom_tool running", liveTools: [], durableRevision: 0 }),
      } as any;
      const viewer = new TranscriptViewer(runtime, state, tui, theme, keybindings, () => {}, false);
      const rendered = viewer.render(100).join("\n");
      assert.match(rendered, /hello/);
      assert.match(rendered, /custom_tool/);
      assert.match(rendered, /Live: custom_tool running/);
      assert.doesNotMatch(rendered, /secret hidden text/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("refreshes durable content and header only when the exact run revision changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-viewer-"));
    try {
      const file = path.join(dir, "child.jsonl");
      const header = { type: "session", version: 3, id: "c", timestamp: "2020-01-01T00:00:00Z", cwd: process.cwd() };
      const first = { type: "message", id: "u", parentId: null, timestamp: "2020-01-01T00:00:01Z", message: { role: "user", content: "first", timestamp: 1 } };
      fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`);
      let view = { snapshot: snapshot(file), liveTools: [], durableRevision: 0 };
      let listener = () => {};
      const runtime = { subscribe: (fn: () => void) => { listener = fn; return () => {}; }, getRunByIds: () => view } as any;
      const viewer = new TranscriptViewer(runtime, view.snapshot, tui, theme, keybindings, () => {}, false);
      assert.match(viewer.render(100).join("\n"), /running.*first/s);
      const second = { type: "message", id: "u2", parentId: "u", timestamp: "2020-01-01T00:00:02Z", message: { role: "user", content: "second", timestamp: 2 } };
      fs.appendFileSync(file, `${JSON.stringify(second)}\n`);
      assert.doesNotMatch(viewer.render(100).join("\n"), /second/);
      view = { snapshot: { ...view.snapshot, status: "completed" }, liveTools: [], durableRevision: 1 };
      listener();
      const refreshed = viewer.render(100).join("\n");
      assert.match(refreshed, /completed/);
      assert.match(refreshed, /second/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("shows curated malformed-session errors instead of crashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-viewer-"));
    try {
      const file = path.join(dir, "bad.jsonl");
      fs.writeFileSync(file, "bad\n");
      const state = snapshot(file, "failed");
      const runtime = {
        subscribe: () => () => {},
        getRun: () => ({ snapshot: state, liveTools: [], durableRevision: 0 }),
        getRunByIds: () => ({ snapshot: state, liveTools: [], durableRevision: 0 }),
      } as any;
      const viewer = new TranscriptViewer(runtime, state, tui, theme, keybindings, () => {}, false);
      assert.match(viewer.render(100).join("\n"), /Malformed child session/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("running widget removes terminal runs and enforces the row cap", () => {
    const running = snapshot("/tmp/a");
    const runtime = {
      subscribe: () => () => {},
      getConfig: () => ({ widgetMaxRows: 1, idleWarningMs: 0 }),
      runningViews: () => [{ snapshot: running, preview: "read file" }, { snapshot: { ...running, agentId: "agent-2" } }],
    } as any;
    const widget = new RunningWidget(runtime, tui, theme);
    const lines = widget.render(100);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Explore Inspect files/);
    assert.match(lines[1], /\+1 more/);
  });
});
