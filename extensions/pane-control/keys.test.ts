import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toKittyKey, toZellijKey } from "./keys.ts";

describe("pane-control", () => {

test("named keys translate per backend", () => {
  assert.equal(toKittyKey("Enter"), "enter");
  assert.equal(toZellijKey("Enter"), "Enter");
  assert.equal(toKittyKey("Esc"), "escape");
  assert.equal(toZellijKey("Escape"), "Esc");
  assert.equal(toKittyKey("PageUp"), "page_up");
  assert.equal(toZellijKey("PageUp"), "PageUp");
  assert.equal(toKittyKey("F5"), "f5");
  assert.equal(toZellijKey("f12"), "F12");
});

test("single characters pass through lowercased", () => {
  assert.equal(toKittyKey("q"), "q");
  assert.equal(toZellijKey("Q"), "q");
  assert.equal(toKittyKey("["), "[");
});

test("modifier combos", () => {
  assert.equal(toKittyKey("Ctrl+C"), "ctrl+c");
  assert.equal(toZellijKey("Ctrl+C"), "Ctrl c");
  assert.equal(toKittyKey("Shift+Up"), "shift+up");
  assert.equal(toZellijKey("Shift+Up"), "Shift Up");
  assert.equal(toKittyKey("Ctrl+Shift+Left"), "ctrl+shift+left");
  assert.equal(toZellijKey("Alt+Shift+b"), "Alt Shift b");
  assert.equal(toKittyKey("cmd+Enter"), "super+enter");
});

test("plus key edge cases", () => {
  assert.equal(toKittyKey("+"), "+");
  assert.equal(toKittyKey("Ctrl++"), "ctrl++");
  assert.equal(toZellijKey("Ctrl++"), "Ctrl +");
});

test("duplicate modifiers are deduped", () => {
  assert.equal(toKittyKey("Ctrl+Ctrl+a"), "ctrl+a");
});

test("unknown keys and modifiers throw with guidance", () => {
  assert.throws(() => toKittyKey("Bogus"), /Unknown key "Bogus"/);
  assert.throws(() => toZellijKey("Hyper+a"), /Unknown modifier "Hyper"/);
  assert.throws(() => toKittyKey(""), /Empty key spec/);
});

});
