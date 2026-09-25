import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";

import { resetToolFocus } from "../../shared/tool-focus.ts";
import { compactRow } from "../../shared/tool-row.ts";
import { createEditor, enterNormal, Keys, press, stripAnsiAndCursor, typeText } from "./test-harness.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const row = compactRow<{ query: string }>({ name: "demo", title: ({ args }) => [args.query] });

/**
 * A transcript document the way pi composes it: one row per tool call, each
 * a spacer, the call slot, and the result slot, re-rendered on every frame
 * with pi's global expanded state.
 */
function transcript(ids: string[], outputLines = 1) {
  const global = { expanded: false };
  const states = new Map(ids.map((id) => [id, {}]));
  const document: Component = {
    render(width) {
      const lines: string[] = [];
      for (const id of ids) {
        const context = {
          args: { query: id },
          toolCallId: id,
          state: states.get(id),
          lastComponent: undefined,
          invalidate() {},
          isPartial: false,
          isError: false,
          expanded: global.expanded,
        };
        const output = Array.from({ length: outputLines }, (_, i) => `${id} output ${i + 1}`).join("\n");
        lines.push("");
        lines.push(...row.renderCall(context.args, theme, context).render(width));
        lines.push(
          ...row
            .renderResult({ content: [{ type: "text", text: output }], details: undefined }, { expanded: global.expanded, isPartial: false }, theme, context)
            .render(width),
        );
      }
      return lines;
    },
    invalidate() {},
  };
  return { document, global, lines: () => document.render(80).map((line) => stripAnsiAndCursor(line).trimEnd()) };
}

function setup(ids: string[], options: { fullscreen?: boolean; rows?: number; outputLines?: number } = {}) {
  const fullscreenMode = options.fullscreen ?? true;
  const { editor, tui } = createEditor({
    rows: options.rows ?? 24,
    keybindings: { "app.interrupt": { defaultKeys: "escape" } },
  });
  const doc = transcript(ids, options.outputLines);
  const dock: Component = { render: () => ["", "", ""], invalidate() {} };
  const scrolls: number[] = [];
  const viewport = (options.rows ?? 24) - 3;
  // Clamps like pi's ScrollView: never past the start or the last full page.
  const fullscreen = {
    viewportTop: 0,
    scrollBy(lines: number) {
      scrolls.push(lines);
      const max = Math.max(0, doc.lines().length - viewport);
      fullscreen.viewportTop = Math.max(0, Math.min(max, fullscreen.viewportTop + lines));
    },
  };
  Object.assign(tui, {
    children: [doc.document, dock],
    terminal: { columns: 80, rows: options.rows ?? 24 },
  });
  // pi swaps renderers behind one stable TUI reference; only fullscreen can scroll.
  const setMode = (mode: "fullscreen" | "regular") => {
    const target = tui as unknown as Record<string, unknown>;
    target.mode = mode;
    if (mode === "fullscreen") {
      Object.defineProperty(tui, "viewportTop", { get: () => fullscreen.viewportTop, configurable: true });
      target.scrollBy = fullscreen.scrollBy;
    } else {
      delete target.viewportTop;
      delete target.scrollBy;
    }
  };
  setMode(fullscreenMode ? "fullscreen" : "regular");
  let submitted: string | undefined;
  editor.onSubmit = (text) => {
    submitted = text;
  };
  return { editor, doc, scrolls, fullscreen, setMode, submitted: () => submitted };
}

const selected = (lines: string[]) => lines.filter((line) => line.startsWith("▶ ")).map((line) => line.slice(2));

describe("helix-mode tool-focus", () => {
  beforeEach(() => resetToolFocus());

  it("moves the selection with , and . starting from the most recent row and clamping at the ends", () => {
    const { editor, doc } = setup(["a", "b", "c"]);
    enterNormal(editor);

    const steps: Array<[string, string]> = [
      [".", "demo ✓ c"],
      [",", "demo ✓ b"],
      [",", "demo ✓ a"],
      [",", "demo ✓ a"],
      [".", "demo ✓ b"],
    ];
    for (const [key, expected] of steps) {
      press(editor, key);
      assert.deepEqual(selected(doc.lines()), [expected], `after ${key}`);
    }
    assert.equal(editor.getText(), "", "navigation keys never insert text");
  });

  it("toggles only the selected row with Enter and submits normally without a selection", () => {
    const { editor, doc, submitted } = setup(["a", "b"]);
    typeText(editor, "hello");
    enterNormal(editor);

    press(editor, ",", "\r");
    assert.deepEqual(doc.lines(), ["", "demo ✓ a", "", "▶ demo ✓ b", "b output 1"]);
    assert.equal(submitted(), undefined, "Enter toggles instead of submitting while a row is selected");

    press(editor, "\r");
    assert.deepEqual(doc.lines(), ["", "demo ✓ a", "", "▶ demo ✓ b"]);

    press(editor, Keys.escape, "\r");
    assert.equal(submitted(), "hello");
  });

  it("keeps a toggled row after the selection clears and resets it when the global state changes", () => {
    const { editor, doc } = setup(["a", "b"]);
    enterNormal(editor);
    press(editor, ".", "\r", Keys.escape);
    assert.deepEqual(doc.lines(), ["", "demo ✓ a", "", "demo ✓ b", "b output 1"]);

    doc.global.expanded = true;
    assert.deepEqual(doc.lines(), ["", "demo ✓ a", "a output 1", "", "demo ✓ b", "b output 1"]);
    doc.global.expanded = false;
    assert.deepEqual(doc.lines(), ["", "demo ✓ a", "", "demo ✓ b"], "ctrl+o resets per-row overrides");
  });

  it("clears the selection with Escape and only then lets Escape reach the app", () => {
    const { editor, doc } = setup(["a"]);
    let interrupts = 0;
    editor.onEscape = () => {
      interrupts++;
    };
    enterNormal(editor);
    press(editor, ".", Keys.escape);
    assert.deepEqual(selected(doc.lines()), []);
    assert.equal(interrupts, 0);

    press(editor, Keys.escape);
    assert.equal(interrupts, 1);
  });

  it("leaves , . and Enter alone in Insert mode and when there are no tool rows", () => {
    const { editor, doc } = setup(["a"]);
    typeText(editor, "x,.");
    assert.equal(editor.getText(), "x,.");
    assert.deepEqual(selected(doc.lines()), []);

    const empty = setup([]);
    typeText(empty.editor, "hi");
    enterNormal(empty.editor);
    press(empty.editor, ".", "\r");
    assert.equal(empty.submitted(), "hi");
  });

  it("scrolls the selected row's title to the top of the fullscreen transcript", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `r${i}`);
    // 24 rows minus a 3-line dock leaves a 21-line viewport over 30 rows × 2 lines.
    const { editor, doc, fullscreen } = setup(ids, { rows: 24, outputLines: 3 });
    enterNormal(editor);
    const titleLine = (id: string) => doc.lines().findIndex((line) => line === `▶ demo ✓ ${id}`);

    press(editor, ".");
    assert.equal(titleLine("r29"), doc.lines().length - 1);
    assert.equal(fullscreen.viewportTop, doc.lines().length - 21, "the last rows cannot scroll past the end");

    for (let i = 0; i < 23; i++) press(editor, ",");
    assert.equal(fullscreen.viewportTop, titleLine("r6"));

    press(editor, "\r");
    assert.equal(fullscreen.viewportTop, titleLine("r6"), "a toggled row stays at the top");
    assert.equal(doc.lines()[fullscreen.viewportTop + 1], "r6 output 1");

    press(editor, ",");
    assert.equal(fullscreen.viewportTop, titleLine("r5"));
    press(editor, ".");
    assert.equal(fullscreen.viewportTop, titleLine("r6"));
  });

  it("is inactive outside fullscreen and resumes with the same selection when fullscreen returns", () => {
    const { editor, doc, setMode, scrolls, submitted } = setup(["a", "b"]);
    let interrupts = 0;
    editor.onEscape = () => {
      interrupts++;
    };
    typeText(editor, "hi");
    enterNormal(editor);
    press(editor, ".");
    assert.deepEqual(selected(doc.lines()), ["demo ✓ b"]);

    setMode("regular");
    const scrollsBefore = scrolls.length;
    assert.deepEqual(selected(doc.lines()), [], "no marker outside fullscreen");
    press(editor, ",", Keys.escape);
    assert.equal(interrupts, 1, "Escape reaches the app");
    assert.equal(scrolls.length, scrollsBefore, "nothing scrolls outside fullscreen");
    assert.equal(editor.getText(), "hi", ", is swallowed like any unbound Normal key");

    setMode("fullscreen");
    assert.deepEqual(selected(doc.lines()), ["demo ✓ b"], "the selection survives the round trip");
    press(editor, ",");
    assert.deepEqual(selected(doc.lines()), ["demo ✓ a"]);

    setMode("regular");
    press(editor, "\r");
    assert.equal(submitted(), "hi", "Enter submits outside fullscreen");
  });
});
