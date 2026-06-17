import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { formatHashlines, hashLine, HASH_LEN, splitLines } from "./hash.ts";
import { applyEdits, type EditOp } from "./apply.ts";
import { defaultStatsPath, readStats, recordEvent } from "./stats.ts";

describe("hash.ts", () => {
  it("hashLine is deterministic and the right shape", () => {
    const a = hashLine("function hello() {");
    const b = hashLine("function hello() {");
    assert.equal(a, b);
    assert.equal(a.length, HASH_LEN);
    assert.match(a, /^[0-9a-f]+$/);
    assert.notEqual(hashLine("a"), hashLine("b"));
    // whitespace changes the hash (stale-anchor detection)
    assert.notEqual(hashLine("foo"), hashLine("foo "));
  });

  it("splitLines: no phantom trailing line, CRLF + BOM normalized", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("﻿a\r\nb"), ["a", "b"]);
  });

  it("formatHashlines emits LINENUM:HASH|CONTENT", () => {
    const out = formatHashlines("foo\nbar", 1);
    const rows = out.split("\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[0], `1:${hashLine("foo")}|foo`);
    assert.equal(rows[1], `2:${hashLine("bar")}|bar`);
    // startLine offset respected
    assert.match(formatHashlines("x", 11), /^11:[0-9a-f]+\|x$/);
  });
});

// Helper to build an anchored op against given content's line.
function anchor(content: string, line: number) {
  const l = splitLines(content)[line - 1];
  return { line, hash: hashLine(l) };
}

describe("apply.ts", () => {
  const FILE = "one\ntwo\nthree\n";

  it("replace single line", () => {
    const a = anchor(FILE, 2);
    const r = applyEdits(FILE, [{ op: "replace", line: a.line, hash: a.hash, body: ["TWO"] }]);
    assert.ok(r.ok);
    assert.equal((r as { content: string }).content, "one\nTWO\nthree\n");
  });

  it("replace range", () => {
    const r = applyEdits(FILE, [
      { op: "replace", ...anchor(FILE, 1), to: anchor(FILE, 2), body: ["X"] } as EditOp,
    ]);
    assert.ok(r.ok);
    assert.equal((r as { content: string }).content, "X\nthree\n");
  });

  it("insert_before / insert_after", () => {
    const r1 = applyEdits(FILE, [{ op: "insert_before", ...anchor(FILE, 1), body: ["zero"] } as EditOp]);
    assert.ok(r1.ok);
    assert.equal((r1 as { content: string }).content, "zero\none\ntwo\nthree\n");

    const r2 = applyEdits(FILE, [{ op: "insert_after", ...anchor(FILE, 3), body: ["four"] } as EditOp]);
    assert.ok(r2.ok);
    assert.equal((r2 as { content: string }).content, "one\ntwo\nthree\nfour\n");
  });

  it("insert_head / insert_tail (no anchor)", () => {
    const r = applyEdits(FILE, [
      { op: "insert_head", body: ["H"] },
      { op: "insert_tail", body: ["T"] },
    ]);
    assert.ok(r.ok);
    assert.equal((r as { content: string }).content, "H\none\ntwo\nthree\nT\n");
  });

  it("delete line and range", () => {
    const r = applyEdits(FILE, [{ op: "delete", ...anchor(FILE, 2) } as EditOp]);
    assert.ok(r.ok);
    assert.equal((r as { content: string }).content, "one\nthree\n");

    const r2 = applyEdits(FILE, [{ op: "delete", ...anchor(FILE, 1), to: anchor(FILE, 2) } as EditOp]);
    assert.ok(r2.ok);
    assert.equal((r2 as { content: string }).content, "three\n");
  });

  it("preserves no-trailing-newline state", () => {
    const noNL = "a\nb";
    const r = applyEdits(noNL, [{ op: "replace", ...anchor(noNL, 1), body: ["A"] } as EditOp]);
    assert.ok(r.ok);
    assert.equal((r as { content: string }).content, "A\nb");
  });

  it("rejects on hash mismatch and leaves intent unchanged", () => {
    const r = applyEdits(FILE, [{ op: "replace", line: 2, hash: "zzz", body: ["TWO"] }]);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.mismatch);
    assert.match((r as { error: string }).error, /hash mismatch at line 2/);
    // error shows real context with the actual hash
    assert.match((r as { error: string }).error, new RegExp(hashLine("two")));
  });

  it("rejects overlapping operations", () => {
    const r = applyEdits(FILE, [
      { op: "replace", ...anchor(FILE, 1), to: anchor(FILE, 2), body: ["X"] } as EditOp,
      { op: "delete", ...anchor(FILE, 2) } as EditOp,
    ]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /overlapping/);
  });

  it("rejects out-of-range anchor", () => {
    const r = applyEdits(FILE, [{ op: "delete", line: 99, hash: "abc" }]);
    assert.equal(r.ok, false);
  });
});

describe("stats.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "hashline-stats-"));
  const statsPath = join(dir, "hashline-stats.json");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("defaultStatsPath points under ~/.pi/agent", () => {
    assert.match(defaultStatsPath(), /\.pi\/agent\/hashline-stats\.json$/);
  });

  it("starts fresh on missing file", () => {
    const s = readStats(statsPath);
    assert.equal(s.active.edit_calls, 0);
    assert.equal(s.inactive.read_calls, 0);
    assert.deepEqual(s.recent, []);
  });

  it("records into the right bucket (atomic read-modify-write)", () => {
    recordEvent({ bucket: "active", tool: "hashline_edit", path: "/f", isError: false, kind: "edit" }, statsPath);
    recordEvent(
      { bucket: "active", tool: "hashline_edit", path: "/f", isError: true, kind: "edit", hashMismatch: true },
      statsPath,
    );
    recordEvent({ bucket: "inactive", tool: "read", path: "/f", isError: false, kind: "read" }, statsPath);

    const s = readStats(statsPath);
    assert.equal(s.active.edit_calls, 2);
    assert.equal(s.active.edit_successes, 1);
    assert.equal(s.active.edit_failures, 1);
    assert.equal(s.active.hash_mismatch_rejections, 1);
    assert.equal(s.inactive.read_calls, 1);
    assert.equal(s.inactive.edit_calls, 0);
    assert.ok(s.active.firstSeen);
    assert.ok(s.active.lastUpdated);
    assert.equal(s.recent.length, 3);
    assert.equal(s.recent[1].kind, "hash_mismatch");
  });

  it("tolerates a corrupt file", () => {
    const p = join(dir, "corrupt.json");
    recordEvent({ bucket: "active", tool: "read", path: "/x", isError: false, kind: "read" }, p);
    // overwrite with garbage, then read
    writeFileSync(p, "{not json");
    const s = readStats(p);
    assert.equal(s.active.read_calls, 0);
  });
});
