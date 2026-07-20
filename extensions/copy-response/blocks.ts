/**
 * copy-response — block parsing and whitespace normalization.
 *
 * Pure string-in/string-out helpers so the algorithm can be tested without the
 * pi runtime. `index.ts` wires these into the /cp command.
 */

/** A fenced code block extracted from a response. */
export interface Fence {
  /** First word of the fence info string, or "" when none. */
  lang: string;
  /** Raw inner lines joined with "\n" (fence lines excluded). */
  content: string;
}

/** A menu entry: a label plus the clipboard-ready (normalized) content. */
export interface CopyOption {
  label: string;
  content: string;
  lineCount: number;
}

/** Split on any EOL style; rejoining with "\n" normalizes CRLF/CR to LF. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Remove trailing spaces/tabs from every line. Whitespace-only lines become "". */
function stripTrailingWhitespace(lines: string[]): string[] {
  return lines.map((line) => line.replace(/[ \t]+$/, ""));
}

/** Drop blank lines (empty after trailing strip) from the start and end only. */
function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].length === 0) start++;
  while (end > start && lines[end - 1].length === 0) end--;
  return lines.slice(start, end);
}

/**
 * Longest leading-whitespace prefix shared by every non-blank line, compared
 * character-by-character (Python textwrap.dedent semantics). Char-wise
 * comparison is tab/space-safe: it only strips whitespace that is genuinely
 * common, so relative indentation is never corrupted.
 */
function commonLeadingWhitespace(lines: string[]): string {
  let prefix: string | null = null;
  for (const line of lines) {
    if (line.length === 0) continue; // interior blank lines don't constrain
    const lead = /^[ \t]*/.exec(line)![0];
    if (prefix === null) {
      prefix = lead;
    } else {
      const max = Math.min(prefix.length, lead.length);
      let i = 0;
      while (i < max && prefix[i] === lead[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (prefix === "") break;
  }
  return prefix ?? "";
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Per-block normalization (the "killer" path for code fences / ASCII diagrams):
 * strip trailing whitespace, drop leading/trailing blank lines, then dedent by
 * the common leading-whitespace prefix. No trailing newline.
 */
export function normalizeBlock(text: string): string {
  let lines = trimEdgeBlankLines(stripTrailingWhitespace(splitLines(text)));
  const prefix = commonLeadingWhitespace(lines);
  if (prefix.length > 0) {
    lines = lines.map((line) => (line.length === 0 ? line : line.slice(prefix.length)));
  }
  return lines.join("\n");
}

/**
 * Whole-response normalization: trailing-whitespace trim and edge-blank trim
 * only. Deliberately no dedent — a full message mixes prose and intentionally
 * indented code, and dedenting it as one unit would shift that code.
 */
export function normalizeWhole(text: string): string {
  return trimEdgeBlankLines(stripTrailingWhitespace(splitLines(text))).join("\n");
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Extract fenced code blocks. Follows CommonMark loosely: a fence opens with
 * three or more backticks/tildes and closes with the same character at equal or
 * greater length. An unclosed fence runs to the end of the text.
 */
export function parseFences(text: string): Fence[] {
  const lines = splitLines(text);
  const fences: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const fenceChar = open[2][0];
    const fenceLen = open[2].length;
    const info = open[3].trim();
    // A backtick info string may not itself contain a backtick.
    if (fenceChar === "`" && info.includes("`")) {
      i++;
      continue;
    }
    const lang = info.split(/\s+/)[0] ?? "";
    const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
    const content: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        closed = true;
        break;
      }
      content.push(lines[j]);
    }
    fences.push({ lang, content: content.join("\n") });
    i = closed ? j + 1 : j;
  }
  return fences;
}

/**
 * Build the copy menu for a response: "Entire response", one entry per fenced
 * block, and "All code blocks" when more than one fence is present. All content
 * is already normalized and ready for the clipboard.
 */
export function buildCopyOptions(responseText: string): CopyOption[] {
  const options: CopyOption[] = [];

  const whole = normalizeWhole(responseText);
  options.push({ label: "Entire response", content: whole, lineCount: countLines(whole) });

  const fences = parseFences(responseText);
  const normalized = fences.map((fence) => normalizeBlock(fence.content));

  fences.forEach((fence, idx) => {
    const content = normalized[idx];
    const lang = fence.lang || "text";
    const n = countLines(content);
    options.push({
      label: `Block ${idx + 1} · ${lang} · ${n} line${n === 1 ? "" : "s"}`,
      content,
      lineCount: n,
    });
  });

  if (fences.length > 1) {
    const combined = normalized.join("\n\n");
    options.push({ label: "All code blocks", content: combined, lineCount: countLines(combined) });
  }

  return options;
}
