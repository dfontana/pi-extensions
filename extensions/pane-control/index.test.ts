import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderRow, textResult, type RenderableTool, type RowResult } from "../shared/render-harness.ts";
import paneControl from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

interface RegisteredTool extends RenderableTool {
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
  /** Detect a (mocked) kitty backend and return the registered pane tools. */
  async function registeredTools(): Promise<Map<string, RegisteredTool>> {
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
    return tools;
  }

  test("registers pane_open with the invoking cwd contract and no cwd input", async () => {
    const restoreEnvironment = setKittyEnvironment();
    try {
      const paneOpen = (await registeredTools()).get("pane_open");
      assert.ok(paneOpen);
      assert.deepEqual(Object.keys(paneOpen.parameters.properties).sort(), ["command", "direction", "name"]);
      assert.match(paneOpen.description, /invoking pane's current working directory/);
      assert.match(paneOpen.description, /`cd` after opening/);
      assert.match(paneOpen.description, /does NOT inherit this session's environment variables/);
    } finally {
      restoreEnvironment();
    }
  });

  test("renders each pane tool as one title line with params and a result summary", async () => {
    const restoreEnvironment = setKittyEnvironment();
    try {
      const tools = await registeredTools();
      const cases: Array<[string, Record<string, unknown>, RowResult, string]> = [
        ["pane_open", { name: "tui", command: "cargo  run" }, textResult("Opened kitty pane 9.", { paneId: "9" }), "pane_open ✓ right tui $ cargo run → pane 9"],
        ["pane_open", { direction: "down" }, textResult("Opened kitty pane 9.", { paneId: "9" }), "pane_open ✓ down → pane 9"],
        ["pane_send", { pane_id: "9", text: "ls\n", enter: true, keys: ["Ctrl+C", "Up"] }, textResult("Sent"), 'pane_send ✓ 9 "ls\\n" ⏎ [Ctrl+C Up]'],
        ["pane_read", { pane_id: "9", scrollback: true, ansi: true }, textResult("a\nb\nc"), "pane_read ✓ 9 scrollback ansi → 3 lines"],
        ["pane_close", { pane_id: "9" }, textResult("Closed pane 9."), "pane_close ✓ 9"],
        ["pane_list", {}, textResult("[]", { panes: 2 }), "pane_list ✓ → 2 panes"],
      ];
      for (const [name, args, result, title] of cases) {
        const tool = tools.get(name)!;
        assert.deepEqual(renderRow(tool, args, result), { title, body: [] }, name);
        assert.deepEqual(renderRow(tool, args, result, { expanded: true }).body, result.content[0].text.split("\n"), name);
      }

      const failure = textResult("pane 9 not found");
      const read = tools.get("pane_read")!;
      assert.deepEqual(renderRow(read, { pane_id: "9" }, failure, { isError: true }), { title: "pane_read ✗ 9", body: [] });
      assert.deepEqual(renderRow(read, { pane_id: "9" }, failure, { isError: true, expanded: true }).body, ["pane 9 not found"]);
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
