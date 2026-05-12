/**
 * label-overlay.ts — gw jump-to-word label machinery.
 *
 * buildLabelMap: given logical lines + render width, assigns single-char
 * labels (a-z, A-Z) to each word-start and returns their visual (row, col).
 *
 * applyLabels: given already-rendered lines (with ANSI) and the label map,
 * strips ANSI, replaces the first character of each labeled word with a
 * bold-red label, and returns the modified lines.
 */

import { wordWrapLine } from "./buffer.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LabelEntry {
  visualRow: number;
  visualCol: number;
  /** Logical position — used for cursor navigation after a label is chosen. */
  logicalLine: number;
  logicalCol: number;
}

/** Maps single-char label (e.g. 'a', 'B') → visual + logical position. */
export type LabelMap = Map<string, LabelEntry>;

// ─── Label alphabet ───────────────────────────────────────────────────────────

const LABELS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ─── ANSI stripping ───────────────────────────────────────────────────────────

/**
 * Strip all ANSI/VT escape sequences from a string, returning plain visible text.
 *
 * NOTE: defined before ANSI_RE so it uses its own inline pattern here.
 * ANSI_RE (below) is the canonical regex; this must stay in sync with it.
 * Critically, the APC pattern (_[^\x07]*\x07) must come FIRST so that
 * CURSOR_MARKER ("\x1b_pi:c\x07") is stripped in full rather than having
 * only the 2-char introducer removed and "pi:c" left behind as visible text.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b(?:_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g, "");
}

// ─── buildLabelMap ────────────────────────────────────────────────────────────

/**
 * Compute the layout width Pi's Editor uses for word-wrap, given the render
 * width and the editor's paddingX.  Mirrors Editor.render() exactly:
 *   contentWidth = width - clampedPad * 2
 *   layoutWidth  = contentWidth - (clampedPad ? 0 : 1)   // reserve cursor col
 */
function computeLayoutWidth(width: number, paddingX: number): number {
  const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
  const clamped = Math.min(paddingX, maxPadding);
  const contentWidth = Math.max(1, width - clamped * 2);
  return Math.max(1, contentWidth - (clamped ? 0 : 1));
}

/**
 * Compute label → position mapping for all word-starts in `lines`.
 *
 * Uses `wordWrapLine` to replicate the editor's visual layout so that
 * `visualRow` and `visualCol` in the returned entries match the actual
 * rendered character positions (accounting for word wrap, the top border
 * row the editor prepends, and the editor's left padding).
 *
 * @param lines       Logical lines from `getLines()`
 * @param width       Render width passed to `render()`
 * @param topBorderRows  Number of top border rows the editor renders (default 1)
 * @param paddingX    Editor left padding in columns (default 1, from `getPaddingX()`)
 */
export function buildLabelMap(
  lines: string[],
  width: number,
  topBorderRows = 1,
  paddingX = 1,
  scrollOffset = 0,
  maxVisibleLines = 9999,
): LabelMap {
  const map: LabelMap = new Map();
  let labelIdx = 0;
  // Absolute visual row (0-indexed, independent of border offset and scroll)
  let visualRow = 0;
  // Layout width: mirrors Pi's Editor.render() formula exactly
  const contentWidth = computeLayoutWidth(width, paddingX);

  outer: for (let logicalLine = 0; logicalLine < lines.length; logicalLine++) {
    const line = lines[logicalLine] ?? "";
    const chunks = wordWrapLine(line, contentWidth);

    for (let ci = 0; ci < chunks.length; ci++) {
      const absVisualRow = visualRow + ci;
      const renderedRow = topBorderRows + (absVisualRow - scrollOffset);
      // Skip rows scrolled above the viewport
      if (renderedRow < topBorderRows) continue;
      // Stop once we are past the visible area
      if (renderedRow >= topBorderRows + maxVisibleLines) break outer;

      const chunk = chunks[ci]!;
      const chunkText = chunk.text;
      const chunkStart = chunk.startIndex; // char offset within the logical line

      // Scan the chunk for word starts
      for (let ci2 = 0; ci2 < chunkText.length; ci2++) {
        const logicalCol = chunkStart + ci2;
        const ch = chunkText[ci2]!;
        const prev = logicalCol === 0 ? null : line[logicalCol - 1]!;

        if (/\w/.test(ch) && (prev === null || !/\w/.test(prev))) {
          if (labelIdx >= LABELS.length) break;
          const label = LABELS[labelIdx++]!;
          // ci2 = offset within chunk = column within this visual row's content
          // Add paddingX because the editor renders content starting at column paddingX
          const visualCol = paddingX + ci2;
          map.set(label, {
            visualRow: renderedRow,
            visualCol,
            logicalLine,
            logicalCol,
          });
        }
      }
    }

    // Advance past all visual rows this logical line occupied
    visualRow += Math.max(1, chunks.length);
  }

  return map;
}

// ─── ANSI-preserving highlight ───────────────────────────────────────────────

/**
 * Regex that matches any ANSI/VT escape sequence as a zero-width unit.
 * Handles (in order):
 *   - APC sequences  \x1b_ ... \x07  (covers CURSOR_MARKER = "\x1b_pi:c\x07")
 *   - CSI sequences  \x1b[ ... final  (SGR, cursor movement, etc.)
 *   - OSC sequences  \x1b] ... \x07  (hyperlinks, etc.)
 *   - Fe/Fp 2-char   \x1b <char>      (fallback for other 2-char escapes)
 */
const ANSI_RE = /\x1b(?:_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g;

/**
 * Single-pass highlight that wraps visible characters in the range
 * [colStart, colEnd] (inclusive, 0-based) with ANSI highlight codes,
 * preserving all existing ANSI sequences — without allocating intermediate
 * token objects.
 *
 * When an ANSI sequence that resets reverse-video passes through while we
 * are inside a selection highlight, the highlight is immediately re-asserted.
 */
function highlightRangeDirect(
  line: string,
  colStart: number,
  colEnd: number,
  highlightOn: string,
  highlightOff: string,
): string {
  let out = "";
  let visCol = 0;
  let inHighlight = false;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(line)) !== null) {
    // Process visible chars between last ANSI match and this one
    for (let i = lastIndex; i < match.index; i++) {
      const shouldHL = visCol >= colStart && visCol <= colEnd;
      if (shouldHL && !inHighlight) { out += highlightOn; inHighlight = true; }
      else if (!shouldHL && inHighlight) { out += highlightOff; inHighlight = false; }
      out += line[i];
      visCol++;
    }
    // Emit the ANSI sequence itself
    out += match[0];
    // If this sequence could have cleared our reverse-video, re-assert it.
    if (inHighlight && resetsHighlight(match[0])) {
      out += highlightOn;
    }
    lastIndex = match.index + match[0].length;
  }
  // Remaining visible chars after the last ANSI sequence
  for (let i = lastIndex; i < line.length; i++) {
    const shouldHL = visCol >= colStart && visCol <= colEnd;
    if (shouldHL && !inHighlight) { out += highlightOn; inHighlight = true; }
    else if (!shouldHL && inHighlight) { out += highlightOff; inHighlight = false; }
    out += line[i];
    visCol++;
  }
  if (inHighlight) out += highlightOff;
  return out;
}

/**
 * Return true if an SGR escape sequence resets reverse-video or all attributes.
 * Matches: \x1b[m  \x1b[0m  \x1b[27m  \x1b[0;...m  any combo containing 0 or 27.
 */
function resetsHighlight(raw: string): boolean {
  const m = raw.match(/^\x1b\[([0-9;]*)m$/);
  if (!m) return false;
  return m[1]!.split(";").some(p => p === "" || p === "0" || p === "27");
}



// ─── applyLabels ─────────────────────────────────────────────────────────────

/** Bold-red ANSI prefix/suffix for label characters. */
const LABEL_ON = "\x1b[1;31m";
const LABEL_OFF = "\x1b[0m";

/**
 * Given the raw rendered lines from `super.render(width)` and a `LabelMap`,
 * produce new lines where each labeled word-start character is replaced with
 * a bold-red label character.
 *
 * We strip ANSI here because gw is a single-keypress interaction and cursor
 * precision during it doesn't matter.
 */
export function applyLabels(renderedLines: string[], labelMap: LabelMap): string[] {
  if (labelMap.size === 0) return renderedLines;

  // Build a per-row list of (visualCol → labelChar) substitutions
  const substitutions = new Map<number, Map<number, string>>();
  for (const [label, entry] of labelMap) {
    if (!substitutions.has(entry.visualRow)) {
      substitutions.set(entry.visualRow, new Map());
    }
    substitutions.get(entry.visualRow)!.set(entry.visualCol, label);
  }

  return renderedLines.map((rawLine, rowIdx) => {
    const subs = substitutions.get(rowIdx);
    if (!subs || subs.size === 0) return rawLine;

    // Strip ANSI to get plain visible characters (acceptable for 1-keypress label mode)
    const plain = stripAnsi(rawLine);
    let out = "";
    for (let col = 0; col < plain.length; col++) {
      const label = subs.get(col);
      if (label !== undefined) {
        out += LABEL_ON + label + LABEL_OFF;
      } else {
        out += plain[col]!;
      }
    }
    return out;
  });
}

// ─── Selection highlight ─────────────────────────────────────────────────────

export interface VisualSpan {
  row: number;
  colStart: number; // inclusive, 0-based
  colEnd: number;   // inclusive
}

/**
 * Map a linear selection range [startOffset, endOffset] (both inclusive) onto
 * visual (row, colStart, colEnd) spans, accounting for word-wrap and paddingX.
 */
export function computeSelectionSpans(
  lines: string[],
  startOffset: number,
  endOffset: number,
  width: number,
  topBorderRows = 1,
  paddingX = 1,
  scrollOffset = 0,
  maxVisibleLines = 9999,
): VisualSpan[] {
  const contentWidth = computeLayoutWidth(width, paddingX);
  const spans: VisualSpan[] = [];
  let visualRow = 0;  // absolute visual row (0-indexed, independent of border/scroll)
  let lineOffset = 0; // linear offset of the first char of the current logical line

  outer: for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    const lineEnd = lineOffset + line.length; // exclusive end of this line in the text
    // Compute chunks once per logical line (used for both overlap and row-count)
    const chunks = wordWrapLine(line, contentWidth);

    // Quick check: does this logical line overlap with the selection at all?
    if (startOffset <= lineEnd && endOffset >= lineOffset) {
      for (let ci = 0; ci < chunks.length; ci++) {
        const absVisualRow = visualRow + ci;
        const renderedRow = topBorderRows + (absVisualRow - scrollOffset);
        // Skip rows scrolled above the viewport
        if (renderedRow < topBorderRows) continue;
        // Stop once we are past the visible area
        if (renderedRow >= topBorderRows + maxVisibleLines) break outer;

        const chunk = chunks[ci]!;
        // Global offsets of chars in this chunk (endIndex exclusive → subtract 1)
        const chunkGlobalStart = lineOffset + chunk.startIndex;
        const chunkGlobalEnd = lineOffset + chunk.endIndex - 1; // inclusive

        const overlapStart = Math.max(startOffset, chunkGlobalStart);
        const overlapEnd = Math.min(endOffset, chunkGlobalEnd);

        if (overlapStart <= overlapEnd) {
          spans.push({
            row: renderedRow,
            colStart: paddingX + (overlapStart - chunkGlobalStart),
            colEnd: paddingX + (overlapEnd - chunkGlobalStart),
          });
        }
      }
    }

    // Advance past all visual rows this logical line occupied
    visualRow += Math.max(1, chunks.length);
    lineOffset += line.length + 1; // +1 for the \n separator
  }

  return spans;
}

/** Reverse-video ANSI codes for selection highlight. */
const SEL_ON = "\x1b[7m";
const SEL_OFF = "\x1b[27m";

/**
 * Apply a reverse-video selection highlight to rendered lines.
 * Preserves all existing ANSI codes (including CURSOR_MARKER) by using
 * an ANSI-aware single-pass highlighter instead of stripping.
 */
export function applySelectionHighlight(
  renderedLines: string[],
  spans: VisualSpan[],
): string[] {
  if (spans.length === 0) return renderedLines;

  // Group spans by row
  const byRow = new Map<number, VisualSpan[]>();
  for (const span of spans) {
    if (!byRow.has(span.row)) byRow.set(span.row, []);
    byRow.get(span.row)!.push(span);
  }

  return renderedLines.map((rawLine, rowIdx) => {
    const rowSpans = byRow.get(rowIdx);
    if (!rowSpans || rowSpans.length === 0) return rawLine;

    // There may be multiple spans per row (e.g. if selection spans multiple
    // words on the same visual line). Merge them into one highlight pass by
    // computing the min colStart and max colEnd.
    const colStart = Math.min(...rowSpans.map(s => s.colStart));
    const colEnd = Math.max(...rowSpans.map(s => s.colEnd));

    return highlightRangeDirect(rawLine, colStart, colEnd, SEL_ON, SEL_OFF);
  });
}
