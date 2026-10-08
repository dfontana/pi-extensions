import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { remapFullscreenScrollBindings } from "../keybindings.js";

describe("helix-mode keybindings", () => {
  it("preserves Pi's Ctrl+Home/End fullscreen bindings and frees Home/End", () => {
    const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS } as typeof TUI_KEYBINDINGS);
    const restore = remapFullscreenScrollBindings(keybindings);

    assert.deepEqual(keybindings.getKeys("tui.altScreen.top"), ["ctrl+home"]);
    assert.deepEqual(keybindings.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
    assert.equal(keybindings.matches("\x1b[H", "tui.altScreen.top"), false);
    assert.equal(keybindings.matches("\x1b[F", "tui.altScreen.bottom"), false);

    restore();
    assert.deepEqual(keybindings.getKeys("tui.altScreen.top"), ["ctrl+home"]);
    assert.deepEqual(keybindings.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
    assert.equal(keybindings.matches("\x1b[H", "tui.altScreen.top"), false);
    assert.equal(keybindings.matches("\x1b[F", "tui.altScreen.bottom"), false);
  });

  it("preserves other user-defined fullscreen scroll shortcuts", () => {
    const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS } as typeof TUI_KEYBINDINGS, {
      "tui.altScreen.top": ["home", "ctrl+up"],
      "tui.altScreen.bottom": ["end", "ctrl+down"],
    });
    const restore = remapFullscreenScrollBindings(keybindings);

    assert.deepEqual(keybindings.getKeys("tui.altScreen.top"), ["alt+home", "ctrl+up"]);
    assert.deepEqual(keybindings.getKeys("tui.altScreen.bottom"), ["alt+end", "ctrl+down"]);

    keybindings.setUserBindings({ ...keybindings.getUserBindings(), "tui.editor.cursorUp": "ctrl+k" });
    restore();
    assert.deepEqual(keybindings.getKeys("tui.altScreen.top"), ["home", "ctrl+up"]);
    assert.deepEqual(keybindings.getKeys("tui.altScreen.bottom"), ["end", "ctrl+down"]);
    assert.deepEqual(keybindings.getKeys("tui.editor.cursorUp"), ["ctrl+k"]);
  });
});
