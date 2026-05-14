/**
 * editor.ts — HelixEditor: a CustomEditor subclass that implements a focused
 * subset of Helix's modal editing keymap for pi's TUI input box.
 *
 * Modes: INSERT (default) · NORMAL · SELECT
 *
 * Key bindings implemented:
 *   Movement    h/l/j/k (+ arrow aliases), w/b/e, 0/$ (+ Home/End)
 *   g-prefix    gg (buffer start), ge (buffer end), gw (jump-to-word labels)
 *   Mode entry  i, a, o, O, v  (Escape → Normal)
 *   Changes     d, c, r+char, x
 *   Indent      > / <
 *   Selection   s (select regex in selection)
 *   Search      * (selection → pattern), n/N (next/prev), / (→ Insert + "/")
 *   Select mode All Normal movements extend the selection
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  lineColToOffset,
  offsetToLineCol,
  offsetToLineColFromLines,
  findMatches,
  wrapWordBoundary,
  deleteRange,
  indentLines,
  unindentLines,
  nextWordStart,
  prevWordStart,
  nextWordEnd,
} from "./buffer.js";
import {
  type SelectionState,
  selectionFromCursor,
  makeSelection,
  normalizeRange,
  selectionStart,
  selectionEnd,
  selectionCharCount,
  selectionLineRange,
  selectionText,
  getSelectionInfo,
} from "./selection.js";
import {
  buildLabelMap,
  applyLabels,
  computeSelectionSpans,
  applySelectionHighlight,
} from "./label-overlay.js";
import type { LabelMap } from "./label-overlay.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = "insert" | "normal" | "select";

interface SearchState {
  pattern: string;
  matches: Array<{ start: number; end: number }>;
  currentIdx: number;
}

interface PendingInput {
  type: "search" | "select_regex";
  buffer: string;
}

// ─── Escape sequences ─────────────────────────────────────────────────────────

const SEQ = {
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  lineStart: "\x01",       // Ctrl+A
  lineEnd: "\x05",         // Ctrl+E
  deleteForward: "\x1b[3~",
} as const;

// ─── HelixEditor ──────────────────────────────────────────────────────────────

export class HelixEditor extends CustomEditor {
  // ── Mode ──────────────────────────────────────────────────────────────────
  private mode: Mode = "insert";

  // ── Selection state (only meaningful in select mode when non-null) ────────
  private selection: SelectionState | null = null;

  // ── Two-key sequence state ────────────────────────────────────────────────
  /** Set to "g" when the user presses `g` in normal mode, waiting for second key. */
  private pendingPrefix: string | null = null;

  /** Set to true when `r` is pressed; next character replaces the char under cursor. */
  private pendingReplace = false;

  // ── Search state ─────────────────────────────────────────────────────────
  private search: SearchState = { pattern: "", matches: [], currentIdx: -1 };

  // ── Mini-prompt (for / and s) ────────────────────────────────────────────
  private pendingInput: PendingInput | null = null;

  // ── gw label mode ────────────────────────────────────────────────────────
  private labelMode = false;
  private labelMap: LabelMap = new Map();
  private lastRenderWidth = 80;

  // ── Theme getter ─────────────────────────────────────────────────────────
  private readonly getTheme: () => Theme;

  constructor(tui: TUI, theme: EditorTheme, getTheme: () => Theme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.getTheme = getTheme;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3a. Mode transitions + label
  // ══════════════════════════════════════════════════════════════════════════

  private resetPendingState(): void {
    this.pendingPrefix = null;
    this.pendingReplace = false;
    this.labelMode = false;
    this.labelMap = new Map();
  }

  private enterInsert(): void {
    this.mode = "insert";
    this.resetPendingState();
    this.selection = null;
  }

  private enterNormal(): void {
    this.mode = "normal";
    this.resetPendingState();
    this.selection = null;
    this.pendingInput = null;
  }

  private enterSelect(): void {
    this.mode = "select";
    this.resetPendingState();
    this.selection = selectionFromCursor(this.getCursor());
  }

  private getModeLabel(): string {
    if (this.mode === "insert") return " INSERT ";
    if (this.mode === "select") {
      const charCount = this.getSelectionCharCount();
      return ` SELECT (${charCount}) `;
    }
    return " NORMAL ";
  }

  private getSelectionCharCount(): number {
    if (!this.selection) return 0;
    const lines = this.getLines();
    return selectionCharCount(lines, this.selection);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // render — border label + mini-prompt + gw labels
  // ══════════════════════════════════════════════════════════════════════════

  override render(width: number): string[] {
    this.lastRenderWidth = width;

    let lines = super.render(width);
    if (lines.length === 0) return lines;

    // Selection highlight — applied before the mode label, preserves CURSOR_MARKER
    if (this.mode === "select" && this.selection && !this.labelMode) {
      const logicalLines = this.getLines();
      const { start, end } = normalizeRange(logicalLines, this.selection);
      const spans = computeSelectionSpans(
        logicalLines, start, end, width, 1, this.getPaddingX(),
        this.getScrollOffset(), this.getMaxVisibleLines(),
      );
      lines = applySelectionHighlight(lines, spans);
    }

    // In label mode, overlay the gw labels (strips ANSI — brief interaction)
    if (this.labelMode && this.labelMap.size > 0) {
      lines = applyLabels(lines, this.labelMap);
    }

    const last = lines.length - 1;

    // Mini-prompt replaces the bottom border content
    if (this.pendingInput !== null) {
      const prefix = this.pendingInput.type === "search" ? "/ " : "s/ ";
      const content = `${prefix}${this.pendingInput.buffer}█`;
      lines[last] = truncateToWidth(content, width, "");
      return lines;
    }

    // Mode label injected into the bottom border
    const label = this.getModeLabel();
    const labelWidth = visibleWidth(label);
    const baseLine = lines[last] ?? "";
    const truncated = truncateToWidth(baseLine, width - labelWidth, "");
    const colored = this.getModeLabelAnsi(label);
    lines[last] = truncated + colored;

    return lines;
  }

  private getModeLabelAnsi(label: string): string {
    const t = this.getTheme();
    if (this.mode === "normal") return t.bold(t.fg("accent", label));
    if (this.mode === "select") return t.bold(t.fg("warning", label));
    return t.fg("muted", label);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3b. handleInput dispatch
  // ══════════════════════════════════════════════════════════════════════════

  override handleInput(data: string): void {
    // ── Label mode: consume next char as label choice ─────────────────────
    if (this.labelMode) {
      this.handleLabelInput(data);
      return;
    }

    // ── Mini-prompt mode ──────────────────────────────────────────────────
    if (this.pendingInput !== null) {
      this.handlePromptInput(data);
      return;
    }

    // ── Pending `r` — replace char ────────────────────────────────────────
    if (this.pendingReplace) {
      this.pendingReplace = false;
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Delete char under cursor then insert replacement
        super.handleInput(SEQ.deleteForward);
        super.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }

    // ── INSERT mode ───────────────────────────────────────────────────────
    if (this.mode === "insert") {
      if (matchesKey(data, "escape")) {
        this.enterNormal();
        this.tui.requestRender();
        return;
      }
      super.handleInput(data);
      return;
    }

    // ── NORMAL / SELECT mode ──────────────────────────────────────────────
    // Conflict policy:
    //   1. Helix modal bindings take absolute precedence — any key that matches
    //      a branch in handleNormalInput fires the Helix action and returns
    //      before this pre-check is ever reached.
    //   2. Printable chars (charCode ≥ 32, length 1) that are NOT claimed by
    //      Helix are offered to the global shortcut layer first:
    //        a. Extension shortcuts registered via pi.registerShortcut() fire
    //           if matched (onExtensionShortcut returns true).
    //        b. App-level keybinding actions registered via onAction() fire if
    //           matched via keybindings.matches().
    //        c. If neither matched, the key is silently swallowed — no text
    //           insertion in Normal/Select mode.
    //   3. Control sequences (charCode < 32 or multi-byte) bypass the
    //      pre-check and go straight to handleNormalInput, which already
    //      forwards unrecognized ones to super.handleInput(data). They carry
    //      no text-insertion risk and already reach the app keybinding layer.
    //   4. Insert mode is unaffected — super.handleInput(data) is called for
    //      every key there, so all shortcuts always fire.
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Step 1: extension-registered shortcuts.  The callback fires the
      // shortcut as a side-effect and returns true if it matched.
      if (this.onExtensionShortcut?.(data)) return;

      // Step 2: app-level keybinding actions registered via onAction().
      for (const [action, handler] of this.actionHandlers) {
        if (this.keybindings.matches(data, action)) {
          handler();
          return;
        }
      }
    }
    this.handleNormalInput(data);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3c. Normal mode movement
  // ══════════════════════════════════════════════════════════════════════════

  private handleNormalInput(data: string): void {
    // Escape in select mode: return to clean Normal (clears selection).
    // Escape in normal mode: pass to super (aborts agent, etc.).
    if (matchesKey(data, "escape")) {
      if (this.mode === "select") {
        this.enterNormal();
        this.tui.requestRender();
        return;
      }
      // Normal mode: forward to super so the app can handle Escape
      // (e.g. abort agent run).
      super.handleInput(data);
      return;
    }

    // ── g-prefix ──────────────────────────────────────────────────────────
    if (this.pendingPrefix === "g") {
      this.pendingPrefix = null;
      this.handleGPrefix(data);
      this.tui.requestRender();
      return;
    }

    // ── Movement ──────────────────────────────────────────────────────────

    // h / Left
    if (data === "h" || matchesKey(data, "left")) {
      this.moveOrExtend(SEQ.left);
      return;
    }
    // l / Right
    if (data === "l" || matchesKey(data, "right")) {
      this.moveOrExtend(SEQ.right);
      return;
    }
    // j / Down
    if (data === "j" || matchesKey(data, "down")) {
      this.moveOrExtend(SEQ.down);
      return;
    }
    // k / Up
    if (data === "k" || matchesKey(data, "up")) {
      this.moveOrExtend(SEQ.up);
      return;
    }
    // w — next word start
    if (data === "w") {
      this.moveWordNext();
      return;
    }
    // b — prev word start
    if (data === "b") {
      this.moveWordPrev();
      return;
    }
    // e — next word end
    if (data === "e") {
      this.moveWordEnd();
      return;
    }
    // 0 / Home — line start
    if (data === "0" || matchesKey(data, "home")) {
      this.moveOrExtend(SEQ.lineStart);
      return;
    }
    // $ / End — line end
    if (data === "$" || matchesKey(data, "end")) {
      this.moveOrExtend(SEQ.lineEnd);
      return;
    }

    // ── g prefix ─────────────────────────────────────────────────────────
    if (data === "g") {
      this.pendingPrefix = "g";
      this.tui.requestRender();
      return;
    }

    // ── Mode entry ────────────────────────────────────────────────────────
    if (data === "i") {
      if (this.selection) {
        const start = selectionStart(this.selection);
        this.navigateTo(start.line, start.col);
      }
      this.enterInsert();
      this.tui.requestRender();
      return;
    }
    if (data === "a") {
      if (this.selection) {
        const end = selectionEnd(this.selection);
        const text = this.getText();
        const lines = this.getLines();
        const endOffset = lineColToOffset(lines, end.line, end.col);
        const afterEnd = offsetToLineColFromLines(lines, Math.min(endOffset + 1, text.length));
        this.navigateTo(afterEnd.line, afterEnd.col);
      } else {
        super.handleInput(SEQ.right);
      }
      this.enterInsert();
      this.tui.requestRender();
      return;
    }
    if (data === "o") {
      // Open line below: insert \n at end of current line, land on the new line.
      const { line } = this.getCursor();
      super.handleInput(SEQ.lineEnd);
      this.insertTextAtCursor("\n");
      this.navigateTo(line + 1, 0);
      this.enterInsert();
      return;
    }
    if (data === "O") {
      // Open line above: insert \n at start of current line.
      // The new empty line takes the current line number; original content shifts down.
      const { line } = this.getCursor();
      super.handleInput(SEQ.lineStart);
      this.insertTextAtCursor("\n");
      this.navigateTo(line, 0);
      this.enterInsert();
      return;
    }
    if (data === "v") {
      this.enterSelect();
      this.tui.requestRender();
      return;
    }

    // ── Changes ───────────────────────────────────────────────────────────
    if (data === "d") { this.actionDelete(); return; }
    if (data === "c") { this.actionChange(); return; }
    if (data === "r") { this.pendingReplace = true; this.tui.requestRender(); return; }
    if (data === "x") { this.actionSelectLine(); return; }

    // ── Indent / unindent ─────────────────────────────────────────────────
    if (data === ">") { this.actionIndent(true); return; }
    if (data === "<") { this.actionIndent(false); return; }

    // ── Selection manipulation ────────────────────────────────────────────
    if (data === "s") { this.startPrompt("select_regex"); return; }

    // ── Search ────────────────────────────────────────────────────────────
    if (data === "*") { this.actionSearchSelection(true); return; }
    if (data === "n") { this.navigateMatch(1); return; }
    if (data === "N") { this.navigateMatch(-1); return; }
    // / — drop into insert mode and forward the slash so slash commands work
    if (data === "/") {
      this.enterInsert();
      super.handleInput("/");
      this.tui.requestRender();
      return;
    }

    // ── Pass control sequences through; swallow printable chars in normal ─
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3c helpers — movement
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Keep sel.head in sync with the cursor after any movement.
   * Called at the end of every movement helper and navigateTo.
   */
  private syncSelectionHead(): void {
    if (this.selection) {
      this.selection = makeSelection(this.selection.anchor, this.getCursor());
    }
  }

  /**
   * Emit a movement sequence and request a re-render.
   * In select mode the anchor stays put; the cursor moves, widening the selection.
   * In normal mode this just repositions the cursor.
   */
  private moveOrExtend(seq: string): void {
    super.handleInput(seq);
    this.syncSelectionHead();
    this.tui.requestRender();
  }

  private moveWordNext(): void {
    const text = this.getText();
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const offset = lineColToOffset(lines, line, col);
    const next = nextWordStart(text, offset);
    const target = offsetToLineColFromLines(lines, next);
    this.navigateTo(target.line, target.col);
    this.syncSelectionHead();
  }

  private moveWordPrev(): void {
    const text = this.getText();
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const offset = lineColToOffset(lines, line, col);
    const prev = prevWordStart(text, offset);
    const target = offsetToLineColFromLines(lines, prev);
    this.navigateTo(target.line, target.col);
    this.syncSelectionHead();
  }

  private moveWordEnd(): void {
    const text = this.getText();
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const offset = lineColToOffset(lines, line, col);
    const end = nextWordEnd(text, offset);
    const target = offsetToLineColFromLines(lines, end);
    this.navigateTo(target.line, target.col);
    this.syncSelectionHead();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3d. navigateTo — move cursor to {line, col} (logical line/col semantics)
  //
  // Semantics:
  //   - `line`  is a 0-based index into getLines() (logical lines separated by \n).
  //   - `col`   is a 0-based character offset within that logical line.
  //   - Both values must be within the bounds of the current text; callers are
  //     responsible for clamping (offsetToLineCol already does this).
  //
  // Why Up/Down is avoided:
  //   Up/Down arrows navigate VISUAL lines in pi's editor, not logical lines.
  //   A logical line longer than the terminal width spans multiple visual lines,
  //   causing off-by-N errors equal to the wrap count. Additionally, pressing Up
  //   on the first visual line of the editor calls moveToLineStart() (no logical
  //   line change) or navigates into shell history — corrupting editor state.
  //
  // Implementation — logical-line traversal:
  //   Ctrl+E (lineEnd) and Ctrl+A (lineStart) operate on state.cursorLine, the
  //   logical line index, and are therefore visual-wrap agnostic. Right/Left at
  //   logical line boundaries cross \n correctly with no history side effects.
  //
  //   Forward (lineDelta > 0): Ctrl+E to end of current logical line, then
  //     Right to cross \n and land at col 0 of the next logical line.
  //   Backward (lineDelta < 0): Ctrl+A to start of current logical line, then
  //     Left to cross \n and land at end of the previous logical line.
  //   Final placement: Ctrl+A to col 0 of target line, then N×Right to targetCol.
  //
  // Known limitation — no direct setCursor() API:
  //   CustomEditor / Editor does not expose a setCursor(line, col) method.
  //   This implementation still uses synthetic key sequences via handleInput,
  //   which is O(|lineDelta| + targetCol) in key events. For typical prompt
  //   sizes this is imperceptible. A future Pi API addition of setCursor() would
  //   allow replacing the entire body with a single atomic call.
  // ══════════════════════════════════════════════════════════════════════════

  private navigateTo(targetLine: number, targetCol: number): void {
    const { line } = this.getCursor();
    const lineDelta = targetLine - line;

    if (lineDelta > 0) {
      // Advance by lineDelta logical lines using lineEnd+Right per boundary.
      for (let i = 0; i < lineDelta; i++) {
        super.handleInput(SEQ.lineEnd);   // Ctrl+E: jump to end of current logical line
        super.handleInput(SEQ.right);     // Right: cross \n → land at col 0 of next logical line
      }
    } else if (lineDelta < 0) {
      // Retreat by |lineDelta| logical lines using lineStart+Left per boundary.
      for (let i = 0; i < -lineDelta; i++) {
        super.handleInput(SEQ.lineStart); // Ctrl+A: jump to start of current logical line
        super.handleInput(SEQ.left);      // Left: cross \n → land at end of previous logical line
      }
    }

    // Land at targetCol: go to start of target logical line, then advance right.
    super.handleInput(SEQ.lineStart);
    for (let i = 0; i < targetCol; i++) super.handleInput(SEQ.right);

    this.syncSelectionHead();
    this.tui.requestRender();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // g-prefix handler
  // ══════════════════════════════════════════════════════════════════════════

  private handleGPrefix(data: string): void {
    if (data === "g") {
      // Buffer start
      this.navigateTo(0, 0);
      return;
    }
    if (data === "e") {
      // Buffer end
      const lines = this.getLines();
      const lastLine = Math.max(0, lines.length - 1);
      const lastCol = (lines[lastLine] ?? "").length;
      this.navigateTo(lastLine, lastCol);
      return;
    }
    if (data === "w") {
      // Jump-to-word label mode
      this.enterLabelMode();
      return;
    }
    // Unknown second key — ignore
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3f. Changes: d, c, r, x
  // ══════════════════════════════════════════════════════════════════════════

  private actionDelete(): void {
    const text = this.getText();
    const lines = this.getLines();
    const info = this.selection ? getSelectionInfo(lines, this.selection) : null;
    if (!info?.isNonEmpty) {
      // No selection or zero-width selection: delete char under cursor
      super.handleInput(SEQ.deleteForward);
      this.selection = null;
      this.mode = "normal";
      this.tui.requestRender();
      return;
    }
    const { start, end } = info;
    const { newText, cursorOffset } = deleteRange(text, start, end);
    const target = offsetToLineCol(newText, cursorOffset);
    this.setText(newText);
    this.navigateTo(target.line, target.col);
    this.selection = null;
    this.mode = "normal";
  }

  private actionChange(): void {
    this.actionDelete();
    this.enterInsert();
    this.tui.requestRender();
  }

  private actionSelectLine(): void {
    const lines = this.getLines();
    const cursor = this.getCursor();

    if (this.mode === "select" && this.selection) {
      // Already in select mode — extend to end of next line
      const { lastLine } = selectionLineRange(this.getText(), lines, this.selection);
      const nextLine = Math.min(lastLine + 1, lines.length - 1);
      const nextLineEnd = (lines[nextLine] ?? "").length;
      this.navigateTo(nextLine, nextLineEnd);
    } else {
      // Enter select mode spanning the current full line
      const lineEnd = (lines[cursor.line] ?? "").length;
      this.selection = makeSelection(
        { line: cursor.line, col: 0 },
        { line: cursor.line, col: lineEnd },
      );
      this.mode = "select";
      this.navigateTo(cursor.line, lineEnd);
    }
    this.tui.requestRender();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3g. Indent / Unindent
  // ══════════════════════════════════════════════════════════════════════════

  private actionIndent(indent: boolean): void {
    const text = this.getText();
    const lines = this.getLines();
    const cursor = this.getCursor();

    let firstLine = cursor.line;
    let lastLine = cursor.line;

    if (this.selection) {
      const lr = selectionLineRange(text, lines, this.selection);
      firstLine = lr.firstLine;
      lastLine = lr.lastLine;
    }

    const newLines = indent
      ? indentLines(lines, firstLine, lastLine, 2)
      : unindentLines(lines, firstLine, lastLine, 2);

    const newText = newLines.join("\n");
    this.setText(newText);
    // Restore cursor to same logical position (adjusted for indent delta)
    const newCursorLine = cursor.line;
    const indentDelta = indent ? 2 : -Math.min(2, lines[cursor.line]?.match(/^ */)?.[0].length ?? 0);
    const newCursorCol = Math.max(0, cursor.col + indentDelta);
    this.navigateTo(newCursorLine, newCursorCol);
    this.tui.requestRender();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3h. Selection manipulation: s (select regex in selection)
  // ══════════════════════════════════════════════════════════════════════════

  /** Called when `s` mini-prompt is confirmed. Finds pattern within selection and jumps to first match. */
  private actionSelectRegex(pattern: string): void {
    if (!pattern) return;
    const text = this.getText();
    const lines = this.getLines();

    // Determine the region to search within
    let searchStart = 0;
    let searchEnd = text.length;
    if (this.selection) {
      const { start, end } = normalizeRange(lines, this.selection);
      searchStart = start;
      searchEnd = end + 1;   // exclusive for text.slice
    }

    const regionText = text.slice(searchStart, searchEnd);
    const rawMatches = findMatches(regionText, pattern);
    if (rawMatches.length === 0) return;

    // Re-offset matches to absolute positions in text; drop zero-length matches
    const matches = rawMatches
      .filter(m => m.end > m.start)
      .map(m => ({
        start: m.start + searchStart,
        end: m.end - 1 + searchStart, // convert exclusive → inclusive
      }));
    if (matches.length === 0) return;

    this.search = { pattern, matches, currentIdx: 0 };
    const first = matches[0]!;
    const target = offsetToLineColFromLines(lines, first.start);
    const endTarget = offsetToLineColFromLines(lines, first.end);
    this.selection = makeSelection(target, endTarget);
    this.mode = "select";
    this.navigateTo(endTarget.line, endTarget.col);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3i. Search: *, /, n, N
  // ══════════════════════════════════════════════════════════════════════════

  private actionSearchSelection(wordBoundary: boolean): void {
    const text = this.getText();
    const lines = this.getLines();
    const cursor = this.getCursor();

    let selectedText: string;
    if (this.selection) {
      selectedText = selectionText(text, lines, this.selection);
    } else {
      // No selection: use word under cursor via prevWordStart / nextWordEnd
      const offset = lineColToOffset(lines, cursor.line, cursor.col);
      const wordStart = prevWordStart(text, offset + 1);  // +1 so current char counts
      const wordEnd   = nextWordEnd(text, offset - 1);    // -1 so current char counts
      selectedText = text.slice(wordStart, wordEnd + 1);
      if (!selectedText) return;
    }

    const pattern = wordBoundary ? wrapWordBoundary(selectedText) : selectedText;
    this.buildSearchState(pattern);
    // Navigate to first match after current cursor
    this.navigateMatch(1);
  }

  private buildSearchState(pattern: string): void {
    // Store only the pattern; navigateMatch recomputes matches from the live
    // text each time so stale offsets are never used after edits.
    this.search = { pattern, matches: [], currentIdx: -1 };
  }

  private navigateMatch(direction: 1 | -1): void {
    if (!this.search.pattern) return;

    // Always recompute matches from the current text so that edits (deletions,
    // insertions) are reflected and stale offsets are never used.
    const text = this.getText();
    const freshMatches = findMatches(text, this.search.pattern)
      .filter(m => m.end > m.start)
      .map(m => ({
        start: m.start,
        end: m.end - 1, // inclusive
      }));
    if (freshMatches.length === 0) return;

    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const currentOffset = lineColToOffset(lines, line, col);

    let idx: number;
    if (direction === 1) {
      // First match whose start is strictly after the cursor
      const found = freshMatches.findIndex(m => m.start > currentOffset);
      idx = found >= 0 ? found : 0; // wrap around
    } else {
      // Last match whose start is strictly before the cursor
      let found = -1;
      for (let i = freshMatches.length - 1; i >= 0; i--) {
        if (freshMatches[i]!.start < currentOffset) { found = i; break; }
      }
      idx = found >= 0 ? found : freshMatches.length - 1; // wrap around
    }

    this.search = { pattern: this.search.pattern, matches: freshMatches, currentIdx: idx };
    const match = freshMatches[idx]!;
    const target = offsetToLineColFromLines(lines, match.start);
    const endTarget = offsetToLineColFromLines(lines, match.end);
    this.selection = makeSelection(target, endTarget);
    this.mode = "select";
    this.navigateTo(endTarget.line, endTarget.col);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3j. Mini prompt for / and s
  // ══════════════════════════════════════════════════════════════════════════

  private startPrompt(type: "search" | "select_regex"): void {
    this.pendingInput = { type, buffer: "" };
    this.tui.requestRender();
  }

  private handlePromptInput(data: string): void {
    if (!this.pendingInput) return;

    if (matchesKey(data, "escape")) {
      this.pendingInput = null;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const { type, buffer } = this.pendingInput;
      this.pendingInput = null;
      if (type === "search") {
        this.buildSearchState(buffer);
        this.navigateMatch(1);
      } else {
        this.actionSelectRegex(buffer);
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.pendingInput.buffer = this.pendingInput.buffer.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    // Append printable characters
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.pendingInput.buffer += data;
      this.tui.requestRender();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3k. gw — label jump mode
  // ══════════════════════════════════════════════════════════════════════════

  /** Read the editor's current scroll offset (private field, accessed via cast). */
  private getScrollOffset(): number {
    return (this as unknown as { scrollOffset: number }).scrollOffset ?? 0;
  }

  /**
   * Estimate the number of content lines visible in the terminal.
   * Uses 30% of terminal rows as a reasonable bound for an inline editor
   * embedded in a taller chat/shell UI, with a minimum of 5.
   */
  private getMaxVisibleLines(): number {
    const rows = this.tui.terminal.rows;
    return Math.max(5, Math.floor(rows * 0.3));
  }

  private enterLabelMode(): void {
    const lines = this.getLines();
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return;

    this.labelMap = buildLabelMap(
      lines, this.lastRenderWidth, 1, this.getPaddingX(),
      this.getScrollOffset(), this.getMaxVisibleLines(),
    );
    if (this.labelMap.size === 0) return;

    this.labelMode = true;
    this.tui.requestRender();
  }

  private handleLabelInput(data: string): void {
    this.labelMode = false;

    if (matchesKey(data, "escape") || data.length !== 1) {
      this.labelMap = new Map();
      this.tui.requestRender();
      return;
    }

    const entry = this.labelMap.get(data);
    this.labelMap = new Map();

    if (entry) {
      this.navigateTo(entry.logicalLine, entry.logicalCol);
    } else {
      this.tui.requestRender();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3l. Select mode — movement already handled above via moveOrExtend.
  // selection.anchor is fixed when entering select mode; selection.head tracks
  // the cursor via syncSelectionHead() called from moveOrExtend / navigateTo.
  // ══════════════════════════════════════════════════════════════════════════
}
