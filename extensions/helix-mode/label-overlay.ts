/**
 * label-overlay.ts — gw jump-to-word label machinery.
 *
 * buildLabelMap: given logical lines + render width, assigns two-character
 * labels (aa-zz) to each word-start and returns their visual (row, col).
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

/** Maps two-char label (e.g. 'aa', 'bc') → visual + logical position. */
export type LabelMap = Map<string, LabelEntry>;

// ─── Label alphabet ───────────────────────────────────────────────────────────

const TWO_CHAR_CHARS = "abcdefghijklmnopqrstuvwxyz"; // 26 lowercase letters

/** Yields all 676 two-character lowercase labels: aa, ab, … az, ba, … zz. */
function* buildTwoCharLabels(): Generator<string> {
  for (const a of TWO_CHAR_CHARS) {
    for (const b of TWO_CHAR_CHARS) {
      yield a + b;
    }
  }
}

// ─── ANSI stripping ───────────────────────────────────────────────────────────

/**
 * Regex that matches any ANSI/VT escape sequence as a zero-width unit.
 * Handles (in order):
 *   - APC sequences  \x1b_ ... \x07  (covers CURSOR_MARKER = "\x1b_pi:c\x07")
 *   - CSI sequences  \x1b[ ... final  (SGR, cursor movement, etc.)
 *   - OSC sequences  \x1b] ... \x07  (hyperlinks, etc.)
 *   - Fe/Fp 2-char   \x1b <char>      (fallback for other 2-char escapes)
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g;

/**
 * Strip all ANSI/VT escape sequences from a string, returning plain visible text.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
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
 * @param lines            Logical lines from `getLines()`
 * @param width            Render width passed to `render()`
 * @param topBorderRows    Number of top border rows the editor renders (default 1)
 * @param paddingX         Editor left padding in columns (default 1, from `getPaddingX()`)
 * @param scrollOffset     Current scroll offset (default 0)
 * @param maxVisibleLines  Max visible content lines (default 9999)
 * @param cursorTextOffset Linear text offset of the cursor; when provided, word
 *                         starts are sorted by proximity so the closest words
 *                         get the earliest labels.
 */
export function buildLabelMap(
  lines: string[],
  width: number,
  topBorderRows = 1,
  paddingX = 1,
  scrollOffset = 0,
  maxVisibleLines = 9999,
  cursorTextOffset?: number,
): LabelMap {
  const map: LabelMap = new Map();
  // Layout width: mirrors Pi's Editor.render() formula exactly
  const contentWidth = computeLayoutWidth(width, paddingX);

  // ── Phase 1: collect all visible word-start candidates ──
  interface Candidate extends LabelEntry {
    textOffset: number;
  }
  const candidates: Candidate[] = [];

  // Absolute visual row (0-indexed, independent of border offset and scroll)
  let visualRow = 0;
  // Linear text offset of the first character of the current logical line
  let lineOffset = 0;

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
        const next = logicalCol >= line.length - 1 ? null : line[logicalCol + 1]!;

        // Label only word starts for words with at least two characters.  A
        // one-character word cannot safely display a two-character overlay
        // without spilling into the next column and visually merging with a
        // neighboring label (matching Helix's behavior).
        if (
          /\w/.test(ch)
          && (prev === null || !/\w/.test(prev))
          && next !== null
          && /\w/.test(next)
        ) {
          // ci2 = offset within chunk = column within this visual row's content
          // Add paddingX because the editor renders content starting at column paddingX
          const visualCol = paddingX + ci2;
          candidates.push({
            visualRow: renderedRow,
            visualCol,
            logicalLine,
            logicalCol,
            textOffset: lineOffset + logicalCol,
          });
        }
      }
    }

    // Advance past all visual rows this logical line occupied
    visualRow += Math.max(1, chunks.length);
    lineOffset += line.length + 1; // +1 for the \n separator
  }

  // ── Phase 2: sort by proximity to cursor (if offset provided) ──
  if (cursorTextOffset !== undefined) {
    candidates.sort((a, b) => {
      const da = Math.abs(a.textOffset - cursorTextOffset);
      const db = Math.abs(b.textOffset - cursorTextOffset);
      if (da !== db) return da - db;
      // Tie-break: forward words (offset ≥ cursor) before backward words
      const aForward = a.textOffset >= cursorTextOffset ? 0 : 1;
      const bForward = b.textOffset >= cursorTextOffset ? 0 : 1;
      return aForward - bForward;
    });
  }

  // ── Phase 3: assign two-char labels ──
  const labelGen = buildTwoCharLabels();
  for (const candidate of candidates) {
    const next = labelGen.next();
    if (next.done) break;
    const { textOffset: _textOffset, ...entry } = candidate;
    map.set(next.value, entry);
  }

  return map;
}

// ─── ANSI-preserving highlight ───────────────────────────────────────────────

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
 * @param renderedLines  Raw output of `super.render(width)`.
 * @param labelMap       Map of full two-char label → position.
 * @param prefixFilter   When `null` (default), every labeled word shows both
 *                       characters of its two-char label.  When a single
 *                       lowercase letter, only labels whose first char matches
 *                       are shown, and each still displays both characters.
 *
 * We strip ANSI here because gw is a two-keypress interaction and cursor
 * precision during it doesn't matter.
 */
export function applyLabels(
  renderedLines: string[],
  labelMap: LabelMap,
  prefixFilter: string | null = null,
): string[] {
  if (labelMap.size === 0) return renderedLines;

  // Build a per-row list of (visualCol → displayChar) substitutions
  const substitutions = new Map<number, Map<number, string>>();
  for (const [label, entry] of labelMap) {
    // When a prefix filter is active, skip labels that don't match it
    if (prefixFilter !== null && label[0] !== prefixFilter) continue;
    if (!substitutions.has(entry.visualRow)) {
      substitutions.set(entry.visualRow, new Map());
    }
    const rowSubs = substitutions.get(entry.visualRow)!;
    rowSubs.set(entry.visualCol, label[0] ?? label);
    if (label[1] !== undefined) {
      rowSubs.set(entry.visualCol + 1, label[1]);
    }
  }

  return renderedLines.map((rawLine, rowIdx) => {
    const subs = substitutions.get(rowIdx);
    if (!subs || subs.size === 0) return rawLine;

    // Strip ANSI to get plain visible characters (acceptable for brief label mode)
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
    let colStart = rowSpans[0]!.colStart;
    let colEnd = rowSpans[0]!.colEnd;
    for (let i = 1; i < rowSpans.length; i++) {
      if (rowSpans[i]!.colStart < colStart) colStart = rowSpans[i]!.colStart;
      if (rowSpans[i]!.colEnd > colEnd) colEnd = rowSpans[i]!.colEnd;
    }

    return highlightRangeDirect(rawLine, colStart, colEnd, SEL_ON, SEL_OFF);
  });
}
