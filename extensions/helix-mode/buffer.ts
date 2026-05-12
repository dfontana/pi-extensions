/**
 * buffer.ts — Pure text-buffer utilities for helix-mode.
 *
 * Imports `visibleWidth` from @earendil-works/pi-tui for grapheme-aware
 * column counting in wordWrapLine. All other functions remain purely functional.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter();

// ─── Offset ↔ Line/Col ───────────────────────────────────────────────────────

/**
 * Convert a logical {line, col} cursor position to a linear character offset.
 * Lines are joined with '\n'.
 */
export function lineColToOffset(lines: string[], line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += (lines[i]?.length ?? 0) + 1; // +1 for \n
  }
  return offset + col;
}

/**
 * Convert a linear character offset to a logical {line, col} cursor position.
 */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let col = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Convert a linear character offset to {line, col} using pre-split lines.
 * O(lines) with early exit — avoids scanning every character.
 */
export function offsetToLineColFromLines(
  lines: string[],
  offset: number,
): { line: number; col: number } {
  let remaining = Math.max(0, offset);
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length;
    if (remaining <= lineLen) {
      return { line: i, col: remaining };
    }
    remaining -= lineLen + 1; // +1 for \n
  }
  // Past end of text — clamp to end of last line
  const lastLine = Math.max(0, lines.length - 1);
  return { line: lastLine, col: lines[lastLine]?.length ?? 0 };
}

// ─── Word Navigation ─────────────────────────────────────────────────────────

/**
 * Find the offset of the next word start strictly after `fromOffset`.
 * Returns `text.length` if no word start exists after the given position.
 */
export function nextWordStart(text: string, fromOffset: number): number {
  for (let i = fromOffset + 1; i < text.length; i++) {
    const ch = text[i]!;
    const prev = text[i - 1]!;
    if (/\w/.test(ch) && !/\w/.test(prev)) return i;
  }
  return text.length;
}

/**
 * Find the offset of the previous word start strictly before `fromOffset`.
 * Returns 0 if no word start exists before the given position.
 */
export function prevWordStart(text: string, fromOffset: number): number {
  for (let i = fromOffset - 1; i >= 0; i--) {
    const ch = text[i]!;
    const prev = i === 0 ? null : text[i - 1]!;
    if (/\w/.test(ch) && (prev === null || !/\w/.test(prev))) return i;
  }
  return 0;
}

/**
 * Find the offset of the next word end at or after `fromOffset`.
 * Returns `text.length - 1` if none found.
 */
export function nextWordEnd(text: string, fromOffset: number): number {
  for (let i = fromOffset + 1; i < text.length; i++) {
    const ch = text[i]!;
    const next = i === text.length - 1 ? null : text[i + 1]!;
    if (/\w/.test(ch) && (next === null || !/\w/.test(next))) return i;
  }
  return Math.max(0, text.length - 1);
}

// ─── Search / Regex ───────────────────────────────────────────────────────────

/**
 * Find all non-overlapping match offsets for `pattern` in `text`.
 * Returns an array of {start, end} pairs (end is exclusive).
 * Returns [] if the pattern is invalid.
 */
export function findMatches(text: string, pattern: string): Array<{ start: number; end: number }> {
  if (!pattern) return [];
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return [];
  }
  const matches: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    matches.push({ start, end });
    // Avoid infinite loop on zero-length match
    if (m[0].length === 0) re.lastIndex++;
  }
  return matches;
}

/**
 * Wrap a plain string in \b word-boundary anchors for whole-word search.
 * Only adds \b on sides that border a \w character.
 */
export function wrapWordBoundary(word: string): string {
  if (!word) return word;
  const left = /\w/.test(word[0]!) ? "\\b" : "";
  const right = /\w/.test(word[word.length - 1]!) ? "\\b" : "";
  return left + escapeRegex(word) + right;
}

/**
 * Escape a string for use as a literal regex pattern.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Selection Helpers ────────────────────────────────────────────────────────

/**
 * Given two cursor positions (anchor and head), return {start, end} as linear offsets
 * where start <= end (inclusive on both ends — Helix-style inclusive selection).
 */
export function selectionRange(
  lines: string[],
  anchor: { line: number; col: number },
  head: { line: number; col: number },
): { start: number; end: number } {
  const a = lineColToOffset(lines, anchor.line, anchor.col);
  const h = lineColToOffset(lines, head.line, head.col);
  return a <= h ? { start: a, end: h } : { start: h, end: a };
}

/**
 * Extract the selected text from `text` given a {start, end} range (inclusive).
 */
export function extractSelection(text: string, start: number, end: number): string {
  return text.slice(start, end + 1);
}

/**
 * Delete the selected range from `text` (inclusive).
 * Returns { newText, cursorOffset } where cursorOffset is the position
 * the cursor should be placed after deletion.
 */
export function deleteRange(
  text: string,
  start: number,
  end: number,
): { newText: string; cursorOffset: number } {
  const newText = text.slice(0, start) + text.slice(end + 1);
  return { newText, cursorOffset: Math.min(start, newText.length) };
}

// ─── Word-wrap layout ───────────────────────────────────────────────────────

export interface VisualChunk {
  /** The visible text of this chunk (no ANSI). */
  text: string;
  /** Starting column index within the logical line. */
  startIndex: number;
  /** Ending column index within the logical line (exclusive). */
  endIndex: number;
}

/**
 * Split a logical line into visual chunks that each fit within `maxWidth`
 * visible columns. Uses Intl.Segmenter for grapheme cluster boundaries and
 * visibleWidth() for correct column counts with wide (CJK, emoji) characters.
 * Mirrors the word-wrap behaviour of pi's Editor: break at word boundaries
 * where possible, fall back to hard breaks for overlong words.
 *
 * An empty line produces exactly one chunk with empty text.
 */
export function wordWrapLine(line: string, maxWidth: number): VisualChunk[] {
  if (maxWidth <= 0) maxWidth = 1;
  if (line.length === 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  if (visibleWidth(line) <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }

  const segments = [...graphemeSegmenter.segment(line)];
  const chunks: VisualChunk[] = [];
  let chunkStart = 0;     // code-unit offset of current chunk start
  let currentWidth = 0;
  let wrapOppIndex = -1;  // code-unit offset of last wrap opportunity (start of next word)
  let wrapOppWidth = 0;   // cumulative column width up to and including the space(s)

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!;
    const glyph = seg.segment;
    const gWidth = visibleWidth(glyph);
    const codeIdx = seg.index; // code-unit position in `line`

    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
        // Backtrack to last recorded wrap opportunity
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < codeIdx) {
        // No suitable wrap opportunity — force a hard break here
        chunks.push({ text: line.slice(chunkStart, codeIdx), startIndex: chunkStart, endIndex: codeIdx });
        chunkStart = codeIdx;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }

    currentWidth += gWidth;

    // Record a wrap opportunity: a space grapheme followed by a non-space grapheme
    const isSpace = /\s/.test(glyph);
    const nextSeg = segments[si + 1];
    if (isSpace && nextSeg && !/\s/.test(nextSeg.segment)) {
      wrapOppIndex = nextSeg.index;
      wrapOppWidth = currentWidth;
    }
  }

  // Emit the final (or only) chunk
  if (chunkStart < line.length) {
    chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  }
  return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}

// ─── Line Operations ─────────────────────────────────────────────────────────

/**
 * Return the range of line indices covered by a selection (start..end offsets).
 * Both returned indices are inclusive.
 */
export function linesInRange(
  text: string,
  start: number,
  end: number,
): { firstLine: number; lastLine: number } {
  const { line: firstLine } = offsetToLineCol(text, start);
  const { line: lastLine } = offsetToLineCol(text, end);
  return { firstLine, lastLine };
}

/**
 * Indent the given logical lines (by index) in `lines` by `indent` spaces.
 * Returns the new lines array.
 */
export function indentLines(lines: string[], firstLine: number, lastLine: number, indent = 2): string[] {
  const pad = " ".repeat(indent);
  return lines.map((l, i) => (i >= firstLine && i <= lastLine ? pad + l : l));
}

/**
 * Unindent the given logical lines (by index) in `lines` by up to `indent` spaces.
 * Returns the new lines array.
 */
export function unindentLines(lines: string[], firstLine: number, lastLine: number, indent = 2): string[] {
  return lines.map((l, i) => {
    if (i < firstLine || i > lastLine) return l;
    let removed = 0;
    while (removed < indent && l[removed] === " ") removed++;
    return l.slice(removed);
  });
}
