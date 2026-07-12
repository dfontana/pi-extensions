import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toKittyKey, toZellijKey } from "./keys.ts";

describe("pane-control keys", () => {
  test("translates supported key specs for each backend", () => {
    const cases = [
      ["Enter", "enter", "Enter"],
      ["Esc", "escape", "Esc"],
      ["PageUp", "page_up", "PageUp"],
      ["F5", "f5", "F5"],
      ["Q", "q", "q"],
      ["Ctrl+C", "ctrl+c", "Ctrl c"],
      ["Shift+Up", "shift+up", "Shift Up"],
      ["Ctrl+Shift+Left", "ctrl+shift+left", "Ctrl Shift Left"],
      ["cmd+Enter", "super+enter", "Super Enter"],
      ["Ctrl++", "ctrl++", "Ctrl +"],
    ] as const;

    for (const [spec, kitty, zellij] of cases) {
      assert.equal(toKittyKey(spec), kitty, `kitty: ${spec}`);
      assert.equal(toZellijKey(spec), zellij, `zellij: ${spec}`);
    }
  });

  test("preserves literal single-character and plus keys", () => {
    assert.equal(toKittyKey("["), "[");
    assert.equal(toKittyKey("+"), "+");
    assert.equal(toKittyKey("Ctrl+Ctrl+a"), "ctrl+a");
  });

  test("rejects invalid key specs with actionable errors", () => {
    for (const [convert, spec, message] of [
      [toKittyKey, "Bogus", /Unknown key "Bogus"/],
      [toZellijKey, "Hyper+a", /Unknown modifier "Hyper"/],
      [toKittyKey, "", /Empty key spec/],
    ] as const) {
      assert.throws(() => convert(spec), message);
    }
  });
});
