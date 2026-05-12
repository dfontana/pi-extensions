/**
 * selection.ts — SelectionState type and pure helper functions for helix-mode.
 *
 * No Pi or TUI dependencies — only imports from buffer.ts.
 * All functions are purely functional and unit-testable in isolation.
 *
 * A selection is the pair (anchor, head) where:
 *   - anchor is the fixed end established when selection begins
 *   - head   is the moving end (tracks the current cursor position)
 *
 * Either end can be the textually earlier position. All normalisation helpers
 * compute start ≤ end from the pair regardless of direction.
 */

import {
  selectionRange,
  extractSelection,
  linesInRange,
} from "./buffer.js";

// ─── Type ────────────────────────────────────────────────────────────────────

/**
 * A selection has a fixed anchor and a moving head.
 * The textually earlier position may be either anchor or head.
 */
export interface SelectionState {
  anchor: { line: number; col: number };
  head:   { line: number; col: number };
}

// ─── Factory helpers ─────────────────────────────────────────────────────────

/**
 * Create a zero-width (collapsed) selection at a single cursor position.
 * anchor === head. Used when entering select mode.
 */
export function selectionFromCursor(
  cursor: { line: number; col: number },
): SelectionState {
  return { anchor: cursor, head: cursor };
}

/**
 * Create a selection from an explicit anchor and head.
 * Either end may be textually earlier.
 */
export function makeSelection(
  anchor: { line: number; col: number },
  head:   { line: number; col: number },
): SelectionState {
  return { anchor, head };
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/**
 * Return {start, end} as inclusive linear offsets with start <= end.
 * Equivalent to: selectionRange(lines, sel.anchor, sel.head)
 */
export function normalizeRange(
  lines: string[],
  sel: SelectionState,
): { start: number; end: number } {
  return selectionRange(lines, sel.anchor, sel.head);
}

/**
 * Compare two {line, col} positions.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function comparePos(
  a: { line: number; col: number },
  b: { line: number; col: number },
): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

/**
 * Return the textually earlier of anchor/head as {line, col}.
 * This is where the cursor lands on `i` (insert before selection).
 */
export function selectionStart(sel: SelectionState): { line: number; col: number } {
  return comparePos(sel.anchor, sel.head) <= 0 ? sel.anchor : sel.head;
}

/**
 * Return the textually later of anchor/head as {line, col}.
 * This is the last selected character for `a` (append after selection).
 */
export function selectionEnd(sel: SelectionState): { line: number; col: number } {
  return comparePos(sel.anchor, sel.head) <= 0 ? sel.head : sel.anchor;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * True when anchor and head map to different offsets (non-zero-width selection).
 * Distinguishes "user made a selection" from "entered select mode but hasn't moved."
 */
export function isNonEmpty(
  lines: string[],
  sel: SelectionState,
): boolean {
  const { start, end } = normalizeRange(lines, sel);
  return start !== end;
}

/**
 * Number of characters covered by the selection (inclusive, minimum 1).
 * Replaces the inline `end - start + 1` pattern.
 */
export function selectionCharCount(
  lines: string[],
  sel: SelectionState,
): number {
  const { start, end } = normalizeRange(lines, sel);
  return end - start + 1;
}

/**
 * Line range (inclusive) covered by the selection.
 * Replaces the pattern: linesInRange(text, range.start, range.end)
 * where range came from normalizeRange / selectionRange.
 */
export function selectionLineRange(
  text: string,
  lines: string[],
  sel: SelectionState,
): { firstLine: number; lastLine: number };
export function selectionLineRange(
  text: string,
  range: { start: number; end: number },
): { firstLine: number; lastLine: number };
export function selectionLineRange(
  text: string,
  linesOrRange: string[] | { start: number; end: number },
  sel?: SelectionState,
): { firstLine: number; lastLine: number } {
  let start: number, end: number;
  if (Array.isArray(linesOrRange)) {
    ({ start, end } = normalizeRange(linesOrRange, sel!));
  } else {
    ({ start, end } = linesOrRange);
  }
  return linesInRange(text, start, end);
}

/**
 * Return the slice of `text` covered by the selection (inclusive).
 * Replaces: extractSelection(text, range.start, range.end)
 */
export function selectionText(
  text: string,
  lines: string[],
  sel: SelectionState,
): string;
export function selectionText(
  text: string,
  range: { start: number; end: number },
): string;
export function selectionText(
  text: string,
  linesOrRange: string[] | { start: number; end: number },
  sel?: SelectionState,
): string {
  let start: number, end: number;
  if (Array.isArray(linesOrRange)) {
    ({ start, end } = normalizeRange(linesOrRange, sel!));
  } else {
    ({ start, end } = linesOrRange);
  }
  return extractSelection(text, start, end);
}

/**
 * Compute all common selection metadata in one pass.
 * Avoids redundant normalizeRange calls when multiple properties are needed.
 */
export function getSelectionInfo(
  lines: string[],
  sel: SelectionState,
): { start: number; end: number; charCount: number; isNonEmpty: boolean } {
  const { start, end } = normalizeRange(lines, sel);
  return { start, end, charCount: end - start + 1, isNonEmpty: start !== end };
}
