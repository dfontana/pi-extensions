import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import paneControl from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
}

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

type Mode = "tui" | "print" | "json" | "rpc";

function context(notifications: string[], mode: Mode = "tui") {
  return {
    mode,
    ui: { notify: (message: string) => notifications.push(message) },
  };
}

describe("pane-control index", () => {
  test("registers pane_open with the invoking cwd contract and no cwd input", async () => {
    const restoreEnvironment = setKittyEnvironment();
    try {
      const handlers = new Map<string, Handler>();
      const tools = new Map<string, RegisteredTool>();
      const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => ({
        stdout: args.includes("ls") ? "[]" : "9\n",
        stderr: "",
        code: 0,
        killed: false,
      });
      const pi = {
        on(event: string, handler: Handler) {
          handlers.set(event, handler);
        },
        registerTool(tool: RegisteredTool) {
          tools.set(tool.name, tool);
        },
        exec,
      } as unknown as ExtensionAPI;

      paneControl(pi);
      await handlers.get("session_start")!({}, context([], "tui"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const paneOpen = tools.get("pane_open");
      assert.ok(paneOpen);
      assert.deepEqual(Object.keys(paneOpen.parameters.properties).sort(), ["command", "direction", "name"]);
      assert.match(paneOpen.description, /invoking pane's current working directory/);
      assert.match(paneOpen.description, /`cd` after opening/);
      assert.match(paneOpen.description, /does NOT inherit this session's environment variables/);
    } finally {
      restoreEnvironment();
    }
  });

  test("skips probe, tools, and notification for headless session starts", async () => {
    const restoreEnvironment = setKittyEnvironment();
    try {
      for (const mode of ["print", "json", "rpc"] as const) {
        const handlers = new Map<string, Handler>();
        const registered: unknown[] = [];
        const notifications: string[] = [];
        let execCalls = 0;
        const exec = async (): Promise<ExecResult> => {
          execCalls++;
          return { stdout: "[]", stderr: "", code: 0, killed: false };
        };
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
        await handlers.get("session_start")!({}, context(notifications, mode));
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(execCalls, 0, `${mode} should not probe a backend`);
        assert.equal(registered.length, 0, `${mode} should not register tools`);
        assert.deepEqual(notifications, [], `${mode} should not notify`);
      }
    } finally {
      restoreEnvironment();
    }
  });

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
      await handlers.get("session_start")!({}, context(notifications, "tui"));
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
