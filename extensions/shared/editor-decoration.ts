import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * A process-wide input-box decoration (a colored border plus a top-left
 * label). Pi has no border API and only one custom editor can be installed,
 * so any extension's editor calls `decorateEditorLines` from its render, and
 * `DecoratedEditor` covers the case where no custom editor is installed.
 */
export interface EditorDecoration {
  label: string;
  color: Parameters<Theme["fg"]>[0];
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

interface State {
  decoration?: EditorDecoration;
  factory?: EditorFactory;
}

const STATE = Symbol.for("pi-extensions.editor-decoration.v1");

function state(): State {
  const global = globalThis as typeof globalThis & { [STATE]?: State };
  return (global[STATE] ??= {});
}

const ANSI = /\x1B\[[0-9;]*m/g;

/** Recolor the top and bottom border lines and put the label at the top left. */
export function decorateEditorLines(lines: string[], theme: Theme): string[] {
  const decoration = state().decoration;
  if (!decoration || lines.length < 2) return lines;
  const { color } = decoration;
  const label = ` ${decoration.label} `;
  const out = [...lines];
  const top = out[0].replace(ANSI, "");
  const labelWidth = visibleWidth(label);
  out[0] = visibleWidth(top) > labelWidth
    ? theme.bold(theme.fg(color, label)) + theme.fg(color, top.slice(labelWidth))
    : theme.fg(color, top);
  const last = out.length - 1;
  out[last] = theme.fg(color, out[last].replace(ANSI, ""));
  return out;
}

class DecoratedEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly getTheme: () => Theme) {
    super(tui, theme, keybindings);
  }

  override render(width: number): string[] {
    return decorateEditorLines(super.render(width), this.getTheme());
  }
}

/** Install `DecoratedEditor` while a decoration is set and no custom editor is present. */
export function ensureDecoratedEditor(ui: ExtensionUIContext): void {
  const current = state();
  if (!current.decoration || ui.getEditorComponent()) return;
  current.factory = (tui, theme, keybindings) => new DecoratedEditor(tui, theme, keybindings, () => ui.theme);
  ui.setEditorComponent(current.factory);
}

export function setEditorDecoration(ui: ExtensionUIContext, decoration: EditorDecoration | undefined): void {
  const current = state();
  current.decoration = decoration;
  if (decoration) return ensureDecoratedEditor(ui);
  if (current.factory && ui.getEditorComponent() === current.factory) ui.setEditorComponent(undefined);
  current.factory = undefined;
}
