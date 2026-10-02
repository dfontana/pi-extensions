import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import helixMode from "../index.js";

type Handler = (...args: any[]) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => unknown };
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

function identity(value: string): string {
  return value;
}

function createHarness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS } as typeof TUI_KEYBINDINGS) as KeybindingsManager & {
    reload: () => void;
  };
  keybindings.reload = () => keybindings.setUserBindings({});
  setKeybindings(keybindings);

  const tui = { terminal: { rows: 24, cols: 80 }, requestRender() {} };
  const editorTheme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
  const appTheme = { fg: (_color: string, value: string) => value, bold: identity };
  let editorFactory: EditorFactory | undefined;
  const ui = {
    theme: appTheme,
    notify() {},
    getEditorComponent: () => editorFactory,
    setEditorComponent(factory: EditorFactory | undefined) {
      editorFactory = factory;
      factory?.(tui as any, editorTheme as any, keybindings as any);
    },
  };
  const ctx = { ui } as unknown as ExtensionContext & ExtensionCommandContext;

  helixMode({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);

  return { ctx, handlers, commands, keybindings };
}

function pressLifecycleEvent(harness: ReturnType<typeof createHarness>, event: string): void {
  harness.handlers.get(event)?.({ type: event }, harness.ctx);
}

describe("helix-mode", () => {
  it("remaps Home/End during session start, restores on shutdown, and reapplies on reload", () => {
    const harness = createHarness();
    const home = "\x1b[H";
    const end = "\x1b[F";

    pressLifecycleEvent(harness, "session_start");
    assert.equal(getKeybindings(), harness.keybindings);
    assert.equal(harness.keybindings.matches(home, "tui.altScreen.top"), false);
    assert.equal(harness.keybindings.matches(end, "tui.altScreen.bottom"), false);
    assert.deepEqual(harness.keybindings.getKeys("tui.altScreen.top"), ["alt+home"]);
    assert.deepEqual(harness.keybindings.getKeys("tui.altScreen.bottom"), ["alt+end"]);

    harness.keybindings.reload();
    assert.equal(harness.keybindings.matches(home, "tui.altScreen.top"), false);
    assert.equal(harness.keybindings.matches(end, "tui.altScreen.bottom"), false);

    pressLifecycleEvent(harness, "session_shutdown");
    assert.equal(harness.keybindings.matches(home, "tui.altScreen.top"), true);
    assert.equal(harness.keybindings.matches(end, "tui.altScreen.bottom"), true);

    pressLifecycleEvent(harness, "session_start");
    assert.equal(harness.keybindings.matches(home, "tui.altScreen.top"), false);
    assert.equal(harness.keybindings.matches(end, "tui.altScreen.bottom"), false);
  });

  it("restores fullscreen jumps when Helix is toggled off", async () => {
    const harness = createHarness();
    pressLifecycleEvent(harness, "session_start");

    const helixCommand = harness.commands.get("helix");
    assert.ok(helixCommand);
    await helixCommand.handler("", harness.ctx);

    assert.equal(harness.keybindings.matches("\x1b[H", "tui.altScreen.top"), true);
    assert.equal(harness.keybindings.matches("\x1b[F", "tui.altScreen.bottom"), true);
  });
});
