import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import helix from "../helix-mode/index.ts";
import { createEditor, normalizedRender } from "../helix-mode/__tests__/test-harness.ts";
import { decorateEditorLines, setEditorDecoration } from "./editor-decoration.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `*${text}*` } as any;

function fakeUi() {
  let editor: unknown;
  return {
    theme,
    notify() {},
    getEditorComponent: () => editor,
    setEditorComponent: (factory: unknown) => { editor = factory; },
  } as any;
}

describe("shared editor-decoration", () => {
  it("recolors both borders and labels the top-left only while a decoration is set", () => {
    const ui = fakeUi();
    const lines = ["\x1B[2m──────────\x1B[0m", " text", "──────────"];
    assert.deepEqual(decorateEditorLines(lines, theme), lines);

    setEditorDecoration(ui, { label: "VIBE", color: "accent" });
    assert.deepEqual(decorateEditorLines(lines, theme), [
      "*<accent> VIBE </accent>*<accent>────</accent>",
      " text",
      "<accent>──────────</accent>",
    ]);
    setEditorDecoration(ui, undefined);
    assert.deepEqual(decorateEditorLines(lines, theme), lines);
  });

  it("installs its own editor only when none is present and composes with helix", async () => {
    const handlers = new Map<string, any>();
    const commands = new Map<string, any>();
    helix({
      on: (event: string, handler: any) => handlers.set(event, handler),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerShortcut() {},
    } as unknown as ExtensionAPI);
    const ui = fakeUi();
    const ctx = { ui } as any;

    handlers.get("session_start")({}, ctx);
    const helixFactory = ui.getEditorComponent();
    assert.ok(helixFactory);
    setEditorDecoration(ui, { label: "VIBE", color: "accent" });
    assert.equal(ui.getEditorComponent(), helixFactory, "helix stays installed and draws the decoration itself");

    await commands.get("helix").handler("", ctx);
    const decorated = ui.getEditorComponent();
    assert.ok(decorated && decorated !== helixFactory, "turning helix off keeps the border via the decorated editor");

    setEditorDecoration(ui, undefined);
    assert.equal(ui.getEditorComponent(), undefined);
  });

  it("draws the label on helix's top border alongside helix's own mode label", () => {
    const ui = fakeUi();
    const { editor } = createEditor();
    setEditorDecoration(ui, { label: "VIBE", color: "accent" });
    try {
      const lines = normalizedRender(editor, 30);
      assert.match(lines[0], /^ VIBE ─+$/);
      assert.match(lines.at(-1)!, /INSERT/);
    } finally {
      setEditorDecoration(ui, undefined);
    }
  });
});
