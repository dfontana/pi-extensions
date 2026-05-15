import type { KeybindingsManager as AppKeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import { HelixEditor } from "../editor.js";

export const Keys = {
  escape: "\x1b",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  deleteForward: "\x1b[3~",
  lineStart: "\x01",
  lineEnd: "\x05",
} as const;

export interface MockTui {
  terminal: { rows: number; cols: number };
  renderRequests: number;
  requestRender: () => void;
}

export interface TestEditorContext {
  editor: HelixEditor;
  tui: MockTui;
}

export interface CreateEditorOptions {
  rows?: number;
  cols?: number;
  focused?: boolean;
  paddingX?: number;
}

export function createEditor(options: CreateEditorOptions = {}): TestEditorContext {
  const tui = createMockTui(options);
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);

  const editor = new HelixEditor(
    tui as unknown as TUI,
    editorTheme,
    () => appTheme,
    keybindings as unknown as AppKeybindingsManager,
  );
  editor.focused = options.focused ?? true;
  if (options.paddingX !== undefined) editor.setPaddingX(options.paddingX);

  return { editor, tui };
}

function createMockTui(options: CreateEditorOptions): MockTui {
  const tui: MockTui = {
    terminal: {
      rows: options.rows ?? 24,
      cols: options.cols ?? 80,
    },
    renderRequests: 0,
    requestRender: () => {
      tui.renderRequests++;
    },
  };
  return tui;
}

const identity = (value: string): string => value;

const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

const appTheme = {
  fg: (_color: string, value: string) => value,
  bold: identity,
} as unknown as Theme;

export function press(editor: HelixEditor, ...keys: string[]): void {
  for (const key of keys) editor.handleInput(key);
}

export function typeText(editor: HelixEditor, text: string): void {
  for (const char of text) editor.handleInput(char);
}

export function enterNormal(editor: HelixEditor): void {
  press(editor, Keys.escape);
}

export function moveToCol(editor: HelixEditor, col: number): void {
  press(editor, "0");
  for (let i = 0; i < col; i++) press(editor, "l");
}

export function repeatKey(editor: HelixEditor, key: string, count: number): void {
  for (let i = 0; i < count; i++) press(editor, key);
}

export function stripAnsiAndCursor(value: string): string {
  return value
    .replaceAll(CURSOR_MARKER, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "");
}

export function normalizedRender(editor: HelixEditor, width: number): string[] {
  return editor.render(width).map(stripAnsiAndCursor);
}

export function renderBody(editor: HelixEditor, width: number): string[] {
  const rendered = normalizedRender(editor, width);
  if (rendered.length <= 2) return [];
  return rendered.slice(1, -1).map((line) => line.trimEnd());
}

export function editorSnapshot(editor: HelixEditor, width: number): {
  text: string;
  cursor: { line: number; col: number };
  body: string[];
} {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    body: renderBody(editor, width),
  };
}
