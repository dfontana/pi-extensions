/**
 * pane-control — gives the agent tools to open, drive, and read terminal
 * panes so it can test full-screen TUI apps (and do other multiplexing work)
 * without a human at the keyboard: open a pane, type into it, send named
 * keys, and dump the rendered screen to "see" the layout.
 *
 * Backend preference (probed at session start):
 *   1. kitty remote control (`kitten @`) when running under kitty — including
 *      over SSH/zmx, where control rides the controlling tty via
 *      KITTY_PUBLIC_KEY auth (children of pi inherit pi's tty).
 *   2. zellij (`zellij action`) when inside a zellij session.
 *   3. Neither responds → the tools are not registered and a warning
 *      notification explains which probes failed.
 *
 * The workflow encoded in the tool descriptions comes from the artifacts
 * repo's tui-iteration skill: build → open pane → send input → dump screen →
 * repeat.
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { detectBackend, type DetectResult, type PaneBackend, type Run } from "./backends.ts";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function preview(s: string, max = 40): string {
  return truncateToWidth(s.replace(/\s+/g, " "), max, "…");
}

/** Reuse the tool row's Text component across renders (standard renderCall pattern). */
function renderLine(context: { lastComponent: unknown }, content: string): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(content);
  return text;
}

function registerPaneTools(pi: ExtensionAPI, backend: PaneBackend) {
  // Pane operations are stateful and order-dependent (type, then read), so
  // every tool runs sequentially.

  pi.registerTool({
    name: "pane_open",
    label: "Open Pane",
    description:
      `Open a new ${backend.name} terminal pane (split) next to the user's current one and return its pane_id. ` +
      "Use panes to run and observe interactive/TUI programs that cannot be driven through normal shell pipes: " +
      "open a pane, send input with pane_send, and read the rendered screen with pane_read. " +
      "The pane starts in the invoking pane's current working directory and starts a fresh shell " +
      "(or runs `command` via sh -c). If you need a different directory, `cd` after opening. It does NOT " +
      "inherit this session's environment variables — source env files inside the pane if the program needs them. " +
      "A fresh shell needs a moment to initialize: if pane_read shows your typed text garbled or missing, " +
      "re-send it once the prompt is visible. Close panes you opened with pane_close when done.",
    promptSnippet: "Open a terminal split pane to run/test interactive TUI programs",
    parameters: Type.Object({
      direction: Type.Optional(
        StringEnum(["right", "down"] as const, {
          description: "Where to split relative to the current pane (default right).",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Title for the pane." })),
      command: Type.Optional(
        Type.String({
          description:
            "Command to run in the pane (via sh -c; the pane stays open after it exits). " +
            "Omit to get an interactive shell you can type into with pane_send.",
        }),
      ),
    }),
    executionMode: "sequential",
    renderCall(args, theme, context) {
      let content = theme.fg("toolTitle", theme.bold("pane_open"));
      content += " " + theme.fg("muted", args?.direction ?? "right");
      if (args?.name) content += " " + theme.fg("muted", args.name);
      if (args?.command) content += " " + theme.fg("dim", `$ ${preview(args.command)}`);
      return renderLine(context, content);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const paneId = await backend.open(
        {
          direction: params.direction ?? "right",
          name: params.name,
          command: params.command,
        },
        signal ?? ctx.signal,
      );
      return ok(`Opened ${backend.name} pane ${paneId}. Target it via pane_id "${paneId}".`);
    },
  });

  pi.registerTool({
    name: "pane_send",
    label: "Send to Pane",
    description:
      "Send input to a pane. `text` is typed literally (raw control/escape bytes in it pass through, " +
      "so exotic sequences can be sent as e.g. \\u001b[1;2A); it is NOT submitted unless enter=true. " +
      "`keys` are named keys sent after the text: Enter, Esc, Tab, Space, Backspace, Delete, Insert, " +
      "Up/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, or single characters, with optional " +
      "Ctrl+/Alt+/Shift+ modifiers (e.g. \"Ctrl+C\", \"Shift+Up\"). " +
      "Run a shell command by sending its text with enter=true, then pane_read to see the result. " +
      "Drive a TUI one keypress at a time via `keys`, re-reading the screen between interactions.",
    promptSnippet: "Type text or send keypresses into a terminal pane",
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id from pane_open or pane_list." }),
      text: Type.Optional(Type.String({ description: "Text to type literally into the pane." })),
      enter: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing text (default false)." }),
      ),
      keys: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Named keys to send after the text, in order (e.g. ["Down", "Enter"]).',
        }),
      ),
    }),
    executionMode: "sequential",
    renderCall(args, theme, context) {
      let content = theme.fg("toolTitle", theme.bold("pane_send"));
      if (args?.pane_id) content += " " + theme.fg("muted", args.pane_id);
      if (args?.text !== undefined) content += " " + theme.fg("dim", `"${preview(args.text)}"`);
      if (args?.enter) content += " " + theme.fg("dim", "⏎");
      if (args?.keys?.length) content += " " + theme.fg("dim", `[${args.keys.join(" ")}]`);
      return renderLine(context, content);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.text === undefined && !params.enter && !params.keys?.length) {
        throw new Error("Nothing to send: provide text, enter, and/or keys.");
      }
      await backend.send(
        params.pane_id,
        { text: params.text, enter: params.enter, keys: params.keys },
        signal ?? ctx.signal,
      );
      const sent = [
        params.text !== undefined ? `text (${params.text.length} chars)` : undefined,
        params.enter ? "Enter" : undefined,
        params.keys?.length ? `keys: ${params.keys.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" + ");
      return ok(`Sent ${sent} to pane ${params.pane_id}.`);
    },
  });

  pi.registerTool({
    name: "pane_read",
    label: "Read Pane",
    description:
      "Read the rendered screen contents of a pane — this is how you \"see\" a TUI without a screenshot: " +
      "read the box-drawing output as the actual layout. If the program crashed, the panic/exception text " +
      "appears here as plain terminal output — read it rather than assuming a capture glitch. " +
      "Focus/selection highlighting is usually color-only, so it is invisible in a plain dump; " +
      "set ansi=true to see styling escapes, or verify focus functionally instead. " +
      "scrollback=true includes history beyond the visible viewport.",
    promptSnippet: "Read the rendered screen of a terminal pane",
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id from pane_open or pane_list." }),
      scrollback: Type.Optional(
        Type.Boolean({ description: "Include scrollback history, not just the visible screen." }),
      ),
      ansi: Type.Optional(
        Type.Boolean({ description: "Preserve ANSI color/style escape codes in the output." }),
      ),
    }),
    executionMode: "sequential",
    renderCall(args, theme, context) {
      let content = theme.fg("toolTitle", theme.bold("pane_read"));
      if (args?.pane_id) content += " " + theme.fg("muted", args.pane_id);
      const bits = [args?.scrollback && "scrollback", args?.ansi && "ansi"].filter(Boolean);
      if (bits.length) content += " " + theme.fg("dim", `(${bits.join(", ")})`);
      return renderLine(context, content);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const screen = await backend.read(
        params.pane_id,
        { scrollback: params.scrollback, ansi: params.ansi },
        signal ?? ctx.signal,
      );
      return ok(screen);
    },
  });

  pi.registerTool({
    name: "pane_close",
    label: "Close Pane",
    description:
      "Close a pane, killing whatever is running in it. Clean up panes you opened once you are done.",
    promptSnippet: "Close a terminal pane",
    parameters: Type.Object({
      pane_id: Type.String({ description: "Pane id from pane_open or pane_list." }),
    }),
    executionMode: "sequential",
    renderCall(args, theme, context) {
      let content = theme.fg("toolTitle", theme.bold("pane_close"));
      if (args?.pane_id) content += " " + theme.fg("muted", args.pane_id);
      return renderLine(context, content);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      await backend.close(params.pane_id, signal ?? ctx.signal);
      return ok(`Closed pane ${params.pane_id}.`);
    },
  });

  pi.registerTool({
    name: "pane_list",
    label: "List Panes",
    description:
      "List the panes in the user's terminal session (ids, titles, running commands). " +
      "Use it to rediscover a pane_id or inspect the current layout. " +
      "Only drive panes you opened yourself unless the user asks you to control theirs.",
    promptSnippet: "List terminal panes in the current session",
    parameters: Type.Object({}),
    executionMode: "sequential",
    renderCall(_args, theme, context) {
      return renderLine(context, theme.fg("toolTitle", theme.bold("pane_list")));
    },
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const panes = await backend.list(signal ?? ctx.signal);
      return ok(JSON.stringify(panes, null, 2));
    },
  });
}

export default function (pi: ExtensionAPI) {
  // Pane tools are terminal/TUI-only. In-process subagent sessions inherit
  // extensions but run headlessly, so skip them before detection to avoid
  // competing with the active TUI for Kitty's controlling-TTY response stream.
  //
  // Probe once per process — the terminal environment can't change under us —
  // and never block session startup on the probes (up to 3s each): pi awaits
  // every session_start handler serially, so detection runs detached and
  // registers the tools (pi refreshes the tool list) or warns when it resolves.
  //
  // A detached probe can outlive print mode or a session reload. Discard its
  // result when the owning extension runtime shuts down; otherwise its captured
  // pi would try to register tools on a stale runtime. The probes already have
  // a three-second timeout, so leaving an in-flight child alone also avoids
  // extending shutdown with pi.exec's force-kill timer.
  let detection: Promise<DetectResult> | undefined;
  let handled = false;
  let active = true;

  pi.on("session_shutdown", () => {
    active = false;
  });

  pi.on("session_start", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    const run: Run = (cmd, args, options) => pi.exec(cmd, args, options);
    detection ??= detectBackend(process.env, run);
    void detection
      .then((result) => {
        if (!active || handled) return;
        handled = true;
        if (result.backend) {
          registerPaneTools(pi, result.backend);
        } else {
          ctx.ui.notify(`pane-control disabled: ${result.reason}`, "warning");
        }
      })
      .catch((error: unknown) => {
        if (!active || handled) return;
        handled = true;
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pane-control disabled: backend detection failed: ${detail}`, "warning");
      });
  });
}
