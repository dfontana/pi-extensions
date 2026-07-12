import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { KittyBackend, ZellijBackend, detectBackend, type Run } from "./backends.ts";

describe("pane-control backends", () => {
  interface Call { cmd: string; args: string[] }

  function fakeRun(script: (call: Call) => Partial<ExecResult> | undefined = () => ({})) {
    const calls: Call[] = [];
    const run: Run = async (cmd, args) => {
      const call = { cmd, args };
      calls.push(call);
      const result = script(call) ?? {};
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
        killed: false,
      };
    };
    return { calls, run };
  }

  test("opens panes and returns the backend's pane id", async () => {
    for (const [Backend, output, options] of [
      [KittyBackend, "7\n", { direction: "right" as const }],
      [ZellijBackend, "terminal_2\n", { direction: "down" as const, command: "htop" }],
    ] as const) {
      const { run } = fakeRun(() => ({ stdout: output }));
      const backend = new Backend(run);
      assert.equal(await backend.open(options), output.trim());
    }
  });

  test("rejects an open operation when the backend does not return a pane id", async () => {
    const cases = [
      [new KittyBackend(fakeRun(() => ({ stdout: "not-a-window-id" })).run), /unexpected output/],
      [new ZellijBackend(fakeRun(() => ({ stdout: "no pane here" })).run), /unexpected output/],
    ] as const;
    for (const [backend, message] of cases) {
      await assert.rejects(backend.open({ direction: "right" }), message);
    }
  });

  test("sends text and keys in the documented order", async () => {
    const kitty = fakeRun();
    await new KittyBackend(kitty.run).send("5", {
      text: 'a\\b "q"', enter: true, keys: ["Down", "Ctrl+C"],
    });
    assert.equal(kitty.calls.length, 4);
    assert.match(kitty.calls[0].args.join(" "), /a\\\\b/);
    assert.equal(kitty.calls[1].args.at(-1), "enter");
    assert.equal(kitty.calls[2].args.at(-1), "down");
    assert.equal(kitty.calls[3].args.at(-1), "ctrl+c");

    const zellij = fakeRun();
    await new ZellijBackend(zellij.run).send("terminal_2", {
      text: "./app", enter: true, keys: ["Down", "Ctrl+C"],
    });
    assert.equal(zellij.calls.length, 2);
    assert.equal(zellij.calls[0].args.at(-1), "./app");
    assert.deepEqual(zellij.calls[1].args.slice(-3), ["Enter", "Down", "Ctrl c"]);

    const textOnly = fakeRun();
    await new ZellijBackend(textOnly.run).send("terminal_2", { text: "abc" });
    assert.equal(textOnly.calls.length, 1);
  });

  test("closes valid panes without exposing backend-specific details", async () => {
    for (const [backend, paneId] of [
      [new KittyBackend(fakeRun().run), "5"],
      [new ZellijBackend(fakeRun().run), "terminal_2"],
    ] as const) {
      const run = fakeRun();
      const instance = backend.name === "kitty" ? new KittyBackend(run.run) : new ZellijBackend(run.run);
      await instance.close(paneId);
      assert.equal(run.calls.length, 1);
    }
  });

  test("validates all keys before sending anything", async () => {
    for (const [backend, paneId] of [
      [new KittyBackend(fakeRun().run), "5"],
      [new ZellijBackend(fakeRun().run), "terminal_2"],
    ] as const) {
      const run = fakeRun();
      const instance = backend.name === "kitty" ? new KittyBackend(run.run) : new ZellijBackend(run.run);
      await assert.rejects(instance.send(paneId, {
        text: "rm -i x", keys: ["Down", "Bogus"],
      }), /Unknown key "Bogus"/);
      assert.equal(run.calls.length, 0);
    }
  });

  test("reads pane output and supports scrollback and ANSI modes", async () => {
    for (const [backend, paneId, expectedFlags] of [
      [new KittyBackend(fakeRun(() => ({ stdout: "screen" })).run), "2", ["--extent=all", "--ansi"]],
      [new ZellijBackend(fakeRun(() => ({ stdout: "screen" })).run), "terminal_2", ["-f", "-a"]],
    ] as const) {
      assert.equal(await backend.read(paneId, { scrollback: true, ansi: true }), "screen");
      // These flags are the observable backend contract for the two modes.
      const run = fakeRun(() => ({ stdout: "screen" }));
      const instance = backend.name === "kitty" ? new KittyBackend(run.run) : new ZellijBackend(run.run);
      await instance.read(paneId, { scrollback: true, ansi: true });
      assert.ok(expectedFlags.every((flag) => run.calls[0].args.includes(flag)));
    }
  });

  test("lists the panes with backend-independent information", async () => {
    const kittyListing = [{ tabs: [{ title: "work", is_focused: true, windows: [
      { id: 1, title: "shell", is_focused: true, cwd: "/home/u", foreground_processes: [{ cmdline: ["zsh"] }] },
      { id: 4, title: "tui", is_focused: false },
    ] }] }];
    const kitty = new KittyBackend(fakeRun(() => ({ stdout: JSON.stringify(kittyListing) })).run);
    assert.deepEqual(await kitty.list(), [
      { pane_id: "1", title: "shell", tab: "work", focused: true, cwd: "/home/u", command: "zsh" },
      { pane_id: "4", title: "tui", tab: "work", focused: false, cwd: undefined, command: undefined },
    ]);

    const zellijListing = [
      { id: 0, is_plugin: true, is_focused: false, title: "status", terminal_command: null, tab_name: "Tab #1" },
      { id: 8, is_plugin: false, is_focused: true, title: "shell", terminal_command: "htop", tab_name: "Tab #1" },
    ];
    const zellij = new ZellijBackend(fakeRun(() => ({ stdout: JSON.stringify(zellijListing) })).run);
    assert.deepEqual(await zellij.list(), [
      { pane_id: "plugin_0", title: "status", tab: "Tab #1", focused: false, command: undefined },
      { pane_id: "terminal_8", title: "shell", tab: "Tab #1", focused: true, command: "htop" },
    ]);
  });

  test("surfaces command failures and rejects unsafe pane ids", async () => {
    const kitty = new KittyBackend(fakeRun(() => ({ code: 1, stderr: "could not connect" })).run);
    await assert.rejects(kitty.read("1", {}), /get-text failed \(exit 1\): could not connect/);
    await assert.rejects(kitty.close("1 or title:.*"), /Invalid kitty window id/);

    const zellij = new ZellijBackend(fakeRun().run);
    await assert.rejects(zellij.read("terminal_2; rm", {}), /Invalid zellij pane id/);
  });

  test("detects a live preferred backend and falls back when needed", async () => {
    const kitty = fakeRun((call) => call.cmd === "kitten" ? { stdout: "[]" } : { code: 1 });
    assert.equal((await detectBackend({ KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" }, kitty.run)).backend?.name, "kitty");

    const zellij = fakeRun((call) => call.cmd === "kitten" ? { code: 1 } : { stdout: "" });
    assert.equal((await detectBackend({ KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" }, zellij.run)).backend?.name, "zellij");

    const malformed = fakeRun(() => ({ stdout: "Error: remote control disabled" }));
    const result = await detectBackend({ KITTY_WINDOW_ID: "1" }, malformed.run);
    assert.equal(result.backend, undefined);
    assert.ok("reason" in result);
    assert.match(result.reason, /kitten @ ls` did not respond/);
  });

  test("reports why no backend is available", async () => {
    const noCandidate = fakeRun(() => ({ stdout: "[]" }));
    const result = await detectBackend({ TERM: "xterm-256color" }, noCandidate.run);
    assert.ok("reason" in result);
    assert.equal(result.reason, "not running inside kitty or zellij");
    assert.equal(noCandidate.calls.length, 0);

    const unavailable: Run = async () => { throw new Error("spawn ENOENT"); };
    const failed = await detectBackend({ KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" }, unavailable);
    assert.ok("reason" in failed);
    assert.match(failed.reason, /kitten @ ls` did not respond/);
    assert.match(failed.reason, /zellij action` did not respond/);
  });
});
