/**
 * hash.ts — line content hashing + the `LINENUM:HASH|CONTENT` read format.
 *
 * Each source line gets a short content-derived digest. The model anchors edits
 * by `line:hash`; on apply we recompute the hash for that line number and reject
 * if it drifted (the file changed under the model). See apply.ts.
 *
 * Hash choice: sha1 of the exact (LF-normalized) line text, sliced to the first
 * 3 hex chars. 3 hex chars = 4096 buckets. That is short enough to stay terse in
 * the listing yet keeps the expected number of *same-number collisions* ~0 (a
 * collision only matters for two lines that share a line number across reads,
 * which never happens — the anchor is (lineNum, hash), so the hash only has to
 * disambiguate a single line against its own prior content). We deliberately do
 * NOT trim/normalize whitespace: trailing-space changes must change the hash so
 * a stale anchor is caught.
 */

import { createHash } from "node:crypto";

/** Length of the hex digest used as a line anchor. */
export const HASH_LEN = 3;

/** Strip a leading UTF-8 BOM and normalize CRLF/CR to LF. */
export function normalizeContent(content: string): string {
  let c = content;
  if (c.charCodeAt(0) === 0xfeff) c = c.slice(1);
  return c.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Short content hash for a single (already LF-split, exact) line.
 * Deterministic, lowercase hex, HASH_LEN chars.
 */
export function hashLine(line: string): string {
  return createHash("sha1").update(line, "utf8").digest("hex").slice(0, HASH_LEN);
}

/**
 * Split already-normalized (LF, no BOM) content into lines for numbering. A
 * trailing newline does not create a phantom empty final line (so line count
 * matches what a human sees). Use when you already hold normalized text and want
 * to avoid re-normalizing.
 */
export function splitNormalized(norm: string): string[] {
  if (norm === "") return [];
  const lines = norm.split("\n");
  // "a\n" -> ["a",""]; drop the trailing empty element produced by the final LF.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Normalize then split raw content into numbered lines. */
export function splitLines(content: string): string[] {
  return splitNormalized(normalizeContent(content));
}

/**
 * Format file content as one row per line: `LINENUM:HASH|CONTENT`.
 * e.g. `11:a3f|function hello() {`
 */
export function formatHashlines(content: string, startLine = 1): string {
  const lines = splitLines(content);
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = startLine + i;
    rows.push(`${n}:${hashLine(lines[i])}|${lines[i]}`);
  }
  return rows.join("\n");
}
