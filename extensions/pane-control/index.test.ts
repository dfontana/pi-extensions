import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import paneControl from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

function setKittyEnvironment(): () => void {
  const names = ["KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "TERM", "ZELLIJ_SESSION_NAME"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.KITTY_WINDOW_ID = "1";
  delete process.env.KITTY_LISTEN_ON;
  process.env.TERM = "xterm-256color";
  delete process.env.ZELLIJ_SESSION_NAME;
  return () => {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function context(notifications: string[]) {
  return {
    ui: { notify: (message: string) => notifications.push(message) },
  };
}

describe("pane-control index", () => {
  test("does not register tools when detection finishes after session shutdown", async () => {
    const restoreEnvironment = setKittyEnvironment();
    try {
      const handlers = new Map<string, Handler>();
      const registered: unknown[] = [];
      const notifications: string[] = [];
      let resolveExec!: (result: ExecResult) => void;
      const exec = async (): Promise<ExecResult> =>
        await new Promise<ExecResult>((resolve) => {
          resolveExec = resolve;
        });
      const pi = {
        on(event: string, handler: Handler) {
          handlers.set(event, handler);
        },
        registerTool(tool: unknown) {
          registered.push(tool);
        },
        exec,
      } as unknown as ExtensionAPI;

      paneControl(pi);
      await handlers.get("session_start")!({}, context(notifications));
      await handlers.get("session_shutdown")!({});
      resolveExec({ stdout: "[]", stderr: "", code: 0, killed: false });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(registered.length, 0);
      assert.deepEqual(notifications, []);
    } finally {
      restoreEnvironment();
    }
  });
});
