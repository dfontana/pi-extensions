import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { KittyBackend, ZellijBackend, detectBackend, type Run } from "./backends.ts";

describe("pane-control", () => {

interface Call {
  cmd: string;
  args: string[];
}

/** A Run stub that records calls and answers from a per-command script. */
function fakeRun(script: (call: Call) => Partial<ExecResult> | undefined = () => ({})) {
  const calls: Call[] = [];
  const run: Run = async (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    const r = script(call) ?? {};
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0, killed: false };
  };
  return { calls, run };
}

// --- kitty ---

test("kitty open builds a launch split and parses the window id", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "7\n" }));
  const kitty = new KittyBackend(run);
  const id = await kitty.open({ direction: "right", cwd: "/proj", name: "tui-test" });
  assert.equal(id, "7");
  assert.deepEqual(calls[0].cmd, "kitten");
  assert.deepEqual(calls[0].args, [
    "@",
    "launch",
    "--type=window",
    "--location=vsplit",
    "--keep-focus",
    "--cwd=/proj",
    "--title=tui-test",
  ]);
});

test("kitty open down maps to hsplit and command runs held via sh -c", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "3" }));
  const kitty = new KittyBackend(run);
  await kitty.open({ direction: "down", command: "htop -d 10" });
  assert.ok(calls[0].args.includes("--location=hsplit"));
  assert.deepEqual(calls[0].args.slice(-4), ["--hold", "sh", "-c", "htop -d 10"]);
});

test("kitty open rejects unexpected launch output", async () => {
  const { run } = fakeRun(() => ({ stdout: "not-a-window-id" }));
  const kitty = new KittyBackend(run);
  await assert.rejects(kitty.open({ direction: "right" }), /unexpected output/);
});

test("kitty listen socket is threaded through as --to", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "[]" }));
  const kitty = new KittyBackend(run, "unix:/tmp/kitty.sock");
  await kitty.probe();
  assert.deepEqual(calls[0].args, ["@", "--to", "unix:/tmp/kitty.sock", "ls"]);
});

test("kitty send escapes backslashes, then presses enter and keys one call each", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const kitty = new KittyBackend(run);
  await kitty.send("5", { text: 'a\\b "q"', enter: true, keys: ["Down", "Ctrl+C"] });
  assert.deepEqual(calls[0].args, ["@", "send-text", "--match", "id:5", "--", 'a\\\\b "q"']);
  assert.deepEqual(calls[1].args, ["@", "send-key", "--match", "id:5", "enter"]);
  assert.deepEqual(calls[2].args, ["@", "send-key", "--match", "id:5", "down"]);
  assert.deepEqual(calls[3].args, ["@", "send-key", "--match", "id:5", "ctrl+c"]);
});

test("kitty send validates every key before any command runs", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const kitty = new KittyBackend(run);
  await assert.rejects(
    kitty.send("5", { text: "rm -i x", enter: true, keys: ["Down", "Bogus"] }),
    /Unknown key "Bogus"/,
  );
  assert.equal(calls.length, 0);
});

test("kitty send with only enter presses the enter key", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const kitty = new KittyBackend(run);
  await kitty.send("5", { enter: true });
  assert.deepEqual(calls[0].args, ["@", "send-key", "--match", "id:5", "enter"]);
});

test("kitty read maps scrollback/ansi flags", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "screen" }));
  const kitty = new KittyBackend(run);
  assert.equal(await kitty.read("2", { scrollback: true, ansi: true }), "screen");
  assert.deepEqual(calls[0].args, ["@", "get-text", "--match", "id:2", "--extent=all", "--ansi"]);
});

test("kitty rejects non-numeric pane ids (match expressions are queries)", async () => {
  const { run } = fakeRun(() => ({}));
  const kitty = new KittyBackend(run);
  await assert.rejects(kitty.read("1 or title:.*", {}), /Invalid kitty window id/);
  await assert.rejects(kitty.close("all"), /Invalid kitty window id/);
});

test("kitty list flattens ls JSON to per-pane essentials", async () => {
  const ls = [
    {
      tabs: [
        {
          title: "work",
          is_focused: true,
          windows: [
            {
              id: 1,
              title: "shell",
              is_focused: true,
              cwd: "/home/u",
              env: { HUGE: "noise" },
              foreground_processes: [{ cmdline: ["zsh"] }],
            },
            { id: 4, title: "tui", is_focused: false },
          ],
        },
      ],
    },
  ];
  const { run } = fakeRun(() => ({ stdout: JSON.stringify(ls) }));
  const kitty = new KittyBackend(run);
  assert.deepEqual(await kitty.list(), [
    { pane_id: "1", title: "shell", tab: "work", focused: true, cwd: "/home/u", command: "zsh" },
    { pane_id: "4", title: "tui", tab: "work", focused: false, cwd: undefined, command: undefined },
  ]);
});

test("kitty failures surface stderr", async () => {
  const { run } = fakeRun(() => ({ code: 1, stderr: "could not connect" }));
  const kitty = new KittyBackend(run);
  await assert.rejects(kitty.read("1", {}), /kitten @ get-text failed \(exit 1\): could not connect/);
});

// --- zellij ---

test("zellij open builds new-pane and extracts the pane id", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "terminal_2\n" }));
  const zellij = new ZellijBackend(run);
  const id = await zellij.open({ direction: "right", cwd: "/proj", name: "tui-test" });
  assert.equal(id, "terminal_2");
  assert.equal(calls[0].cmd, "zellij");
  assert.deepEqual(calls[0].args, [
    "action",
    "new-pane",
    "-d",
    "right",
    "-n",
    "tui-test",
    "--cwd",
    "/proj",
  ]);
});

test("zellij open with command appends -- sh -c", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "terminal_9" }));
  const zellij = new ZellijBackend(run);
  await zellij.open({ direction: "down", command: "cargo run" });
  assert.deepEqual(calls[0].args.slice(-4), ["--", "sh", "-c", "cargo run"]);
});

test("zellij send writes chars then one send-keys with Enter prepended", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const zellij = new ZellijBackend(run);
  await zellij.send("terminal_2", { text: "./app", enter: true, keys: ["Down", "Ctrl+C"] });
  assert.deepEqual(calls[0].args, ["action", "write-chars", "-p", "terminal_2", "./app"]);
  assert.deepEqual(calls[1].args, [
    "action",
    "send-keys",
    "-p",
    "terminal_2",
    "Enter",
    "Down",
    "Ctrl c",
  ]);
});

test("zellij send validates every key before any command runs", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const zellij = new ZellijBackend(run);
  await assert.rejects(
    zellij.send("terminal_2", { text: "rm -i x", keys: ["Bogus"] }),
    /Unknown key "Bogus"/,
  );
  assert.equal(calls.length, 0);
});

test("zellij list maps list-panes JSON to PaneInfo records", async () => {
  const listing = [
    {
      id: 0,
      is_plugin: true,
      is_focused: false,
      title: "status-bar",
      terminal_command: null,
      tab_name: "Tab #1",
    },
    {
      id: 8,
      is_plugin: false,
      is_focused: true,
      title: "shell",
      terminal_command: "htop",
      tab_name: "Tab #1",
    },
  ];
  const { run } = fakeRun(() => ({ stdout: JSON.stringify(listing) }));
  const zellij = new ZellijBackend(run);
  assert.deepEqual(await zellij.list(), [
    { pane_id: "plugin_0", title: "status-bar", tab: "Tab #1", focused: false, command: undefined },
    { pane_id: "terminal_8", title: "shell", tab: "Tab #1", focused: true, command: "htop" },
  ]);
});

test("zellij send text only does not press enter", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const zellij = new ZellijBackend(run);
  await zellij.send("terminal_2", { text: "abc" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["action", "write-chars", "-p", "terminal_2", "abc"]);
});

test("zellij read maps scrollback/ansi flags", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "screen" }));
  const zellij = new ZellijBackend(run);
  assert.equal(await zellij.read("terminal_2", { scrollback: true, ansi: true }), "screen");
  assert.deepEqual(calls[0].args, ["action", "dump-screen", "-p", "terminal_2", "-f", "-a"]);
});

test("zellij close targets the pane", async () => {
  const { calls, run } = fakeRun(() => ({}));
  const zellij = new ZellijBackend(run);
  await zellij.close("terminal_2");
  assert.deepEqual(calls[0].args, ["action", "close-pane", "-p", "terminal_2"]);
});

test("zellij rejects malformed pane ids", async () => {
  const { run } = fakeRun(() => ({}));
  const zellij = new ZellijBackend(run);
  await assert.rejects(zellij.read("terminal_2; rm", {}), /Invalid zellij pane id/);
});

// --- detection ---

test("prefers kitty when its probe answers, even inside zellij", async () => {
  const { run } = fakeRun((c) => (c.cmd === "kitten" ? { stdout: "[]" } : { code: 1 }));
  const result = await detectBackend(
    { KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" },
    run,
  );
  assert.equal(result.backend?.name, "kitty");
});

test("falls back to zellij when the kitty probe fails", async () => {
  const { run } = fakeRun((c) => (c.cmd === "kitten" ? { code: 1 } : { stdout: "" }));
  const result = await detectBackend(
    { KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" },
    run,
  );
  assert.equal(result.backend?.name, "zellij");
});

test("kitty probe requires JSON output, not just exit 0", async () => {
  // A kitten binary printing an error banner to stdout must not count as live.
  const { run } = fakeRun(() => ({ stdout: "Error: allow_remote_control disabled", code: 0 }));
  const result = await detectBackend({ KITTY_WINDOW_ID: "1" }, run);
  assert.equal(result.backend, undefined);
  assert.match(result.reason!, /kitty env detected but `kitten @ ls` did not respond/);
});

test("no candidate env vars means no probes and a not-inside reason", async () => {
  const { calls, run } = fakeRun(() => ({ stdout: "[]" }));
  const result = await detectBackend({ TERM: "xterm-256color" }, run);
  assert.equal(result.backend, undefined);
  assert.equal(result.reason, "not running inside kitty or zellij");
  assert.equal(calls.length, 0);
});

test("a throwing run (missing binary) disables and reports both probe failures", async () => {
  const run: Run = async () => {
    throw new Error("spawn kitten ENOENT");
  };
  const result = await detectBackend(
    { KITTY_WINDOW_ID: "1", ZELLIJ_SESSION_NAME: "main" },
    run,
  );
  assert.equal(result.backend, undefined);
  assert.match(result.reason!, /kitten @ ls` did not respond/);
  assert.match(result.reason!, /ZELLIJ_SESSION_NAME=main set but `zellij action` did not respond/);
});

});
