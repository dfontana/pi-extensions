/**
 * apply.ts — parse + apply hash-anchored edit operations.
 *
 * The model supplies a structured list of operations, each anchored by
 * `line:hash`. Before touching anything we recompute the hash for every anchor's
 * line number against the CURRENT file; if any anchor's supplied hash does not
 * match the real hash, the WHOLE edit is rejected and we return an actionable
 * error showing the real lines (with hashes) around each bad anchor (±2 lines).
 * This is the core value: the model can't silently edit stale content.
 *
 * All operations address ORIGINAL line numbers (1-based) — they are not applied
 * incrementally — and overlapping operations are rejected. The result is written
 * with LF line endings and the original trailing-newline state is preserved.
 */

import { hashLine, normalizeContent, splitNormalized } from "./hash.ts";

export type Anchor = { line: number; hash: string };

export type EditOp =
  | { op: "replace"; line: number; hash: string; to?: Anchor; body: string[] }
  | { op: "insert_before"; line: number; hash: string; body: string[] }
  | { op: "insert_after"; line: number; hash: string; body: string[] }
  | { op: "insert_head"; body: string[] }
  | { op: "insert_tail"; body: string[] }
  | { op: "delete"; line: number; hash: string; to?: Anchor };

export type ApplyResult =
  | { ok: true; content: string; mismatch: false }
  | { ok: false; error: string; mismatch: boolean };

/** Render ±radius lines of context around `line` (1-based) as hashline rows. */
function contextAround(lines: string[], line: number, radius = 2): string {
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const rows: string[] = [];
  for (let n = from; n <= to; n++) {
    const marker = n === line ? ">" : " ";
    rows.push(`${marker} ${n}:${hashLine(lines[n - 1])}|${lines[n - 1]}`);
  }
  return rows.join("\n");
}

/** Validate one anchor against the current lines. Returns an error string or null. */
function checkAnchor(lines: string[], line: number, hash: string): string | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return `line ${line} is out of range (file has ${lines.length} lines)`;
  }
  const real = hashLine(lines[line - 1]);
  if (real !== hash) {
    return (
      `hash mismatch at line ${line}: you supplied "${hash}" but the current ` +
      `hash is "${real}". The file has changed — re-read it and retry.\n` +
      `Context:\n${contextAround(lines, line)}`
    );
  }
  return null;
}

/**
 * Compute the inclusive original-line range an op touches, for overlap
 * detection. Inserts occupy their anchor line ([line, line]) so they can't
 * collide with a replace/delete of the same line. Head/tail occupy nothing.
 */
function opRange(op: EditOp): { lo: number; hi: number } | null {
  switch (op.op) {
    case "insert_head":
    case "insert_tail":
      return null;
    case "insert_before":
    case "insert_after":
      return { lo: op.line, hi: op.line };
    case "replace":
    case "delete":
      return { lo: op.line, hi: op.to ? op.to.line : op.line };
  }
}

/**
 * Apply ops to `original` content. Pure: returns the new content or an error.
 * `mismatch` distinguishes hash-mismatch rejections (the headline case) from
 * structural errors (overlap, bad range, malformed body).
 */
export function applyEdits(original: string, ops: EditOp[]): ApplyResult {
  const norm = normalizeContent(original);
  const lines = splitNormalized(norm);
  const trailingNL = norm.length > 0 && norm.endsWith("\n");

  if (ops.length === 0) {
    return { ok: false, error: "no operations supplied", mismatch: false };
  }

  // 1. Validate all anchors first (reject whole edit on any mismatch).
  for (const op of ops) {
    if ("body" in op && op.body !== undefined && !Array.isArray(op.body)) {
      return { ok: false, error: `op ${op.op}: body must be an array of lines`, mismatch: false };
    }
    if (op.op === "insert_head" || op.op === "insert_tail") continue;

    const anchorErr = checkAnchor(lines, op.line, op.hash);
    if (anchorErr) return { ok: false, error: anchorErr, mismatch: true };

    if ((op.op === "replace" || op.op === "delete") && op.to) {
      const toErr = checkAnchor(lines, op.to.line, op.to.hash);
      if (toErr) return { ok: false, error: toErr, mismatch: true };
      if (op.to.line < op.line) {
        return {
          ok: false,
          error: `op ${op.op}: range end (line ${op.to.line}) is before start (line ${op.line})`,
          mismatch: false,
        };
      }
    }
  }

  // 2. Overlap detection on original line ranges.
  const ranges = ops
    .map((op) => ({ op, range: opRange(op) }))
    .filter((r): r is { op: EditOp; range: { lo: number; hi: number } } => r.range !== null)
    .sort((a, b) => a.range.lo - b.range.lo || a.range.hi - b.range.hi);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1].range;
    const cur = ranges[i].range;
    if (cur.lo <= prev.hi) {
      return {
        ok: false,
        error: `overlapping operations at lines ${cur.lo}..${cur.hi} and ${prev.lo}..${prev.hi}`,
        mismatch: false,
      };
    }
  }

  // 3. Build the result. `out[i]` is the rendered form of original line i+1 (the
  //    line itself, replacement lines, or null when deleted). `before[g]` holds
  //    lines inserted into gap g — rendered before original line g+1, with gap 0
  //    = head and gap `lines.length` = tail. All ops address original numbers, so
  //    length changes never shift another op's target.
  const out: (string[] | null)[] = lines.map((l) => [l]);
  const before: string[][] = Array.from({ length: lines.length + 1 }, () => []);

  for (const op of ops) {
    switch (op.op) {
      case "insert_head":
        before[0].push(...op.body);
        break;
      case "insert_tail":
        before[lines.length].push(...op.body);
        break;
      case "insert_before":
        before[op.line - 1].push(...op.body);
        break;
      case "insert_after":
        before[op.line].push(...op.body);
        break;
      case "replace": {
        const end = op.to ? op.to.line : op.line;
        for (let n = op.line; n <= end; n++) out[n - 1] = n === op.line ? [...op.body] : [];
        break;
      }
      case "delete": {
        const end = op.to ? op.to.line : op.line;
        for (let n = op.line; n <= end; n++) out[n - 1] = null;
        break;
      }
    }
  }

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(...before[i]);
    if (out[i] !== null) result.push(...(out[i] as string[]));
  }
  result.push(...before[lines.length]);

  let content = result.join("\n");
  if (content.length > 0 && trailingNL) content += "\n";
  return { ok: true, content, mismatch: false };
}
