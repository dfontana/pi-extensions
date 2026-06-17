# hashline

Content-hash-anchored file reading and editing for the pi coding agent, plus
always-on usage statistics. A fresh, minimal reimplementation of the "hashline"
idea from [the harness problem](https://blog.can.ac/2026/02/12/the-harness-problem/).

## Why

Line numbers are a fragile edit anchor: a file can change between the moment the
model reads it and the moment it edits. hashline gives every line a short
content hash and requires edits to cite `line:hash`. On apply, the current hash
for that line number is recomputed; if it has drifted, the **entire edit is
rejected** with an actionable diff so the model re-reads and retries instead of
corrupting the file.

## Read format

`hashline_read` returns one row per line:

```
LINENUM:HASH|CONTENT
```

e.g. `11:a3f|function hello() {`. The hash is the first 3 hex chars of the
SHA-1 of the exact (LF-normalized, BOM-stripped) line text. Whitespace is
significant — a trailing-space change changes the hash.

## Edit operations

`hashline_edit` takes `{ path, operations: [...] }`. Each operation:

| op              | fields                                  | meaning |
|-----------------|-----------------------------------------|---------|
| `replace`       | `line`, `hash`, optional `to:{line,hash}`, `body` | replace a line or `line..to` range with `body` |
| `insert_before` | `line`, `hash`, `body`                  | insert `body` before the anchored line |
| `insert_after`  | `line`, `hash`, `body`                  | insert `body` after the anchored line |
| `insert_head`   | `body`                                  | prepend `body` to the file |
| `insert_tail`   | `body`                                  | append `body` to the file |
| `delete`        | `line`, `hash`, optional `to:{line,hash}` | delete a line or `line..to` range |

`body` is an array of lines (no trailing newlines). All operations address
**original** line numbers (not applied incrementally); overlapping operations
are rejected. Any anchor whose `hash` no longer matches the current file rejects
the whole edit, with ±2 lines of real context (and real hashes) in the error.
The result is written with LF endings, preserving the file's original
trailing-newline state.

## Toggle

`/hashline` flips the extension on/off (default ON). State persists to
`~/.pi/agent/hashline.json` and survives restarts. When OFF, the tools defer to
the built-in `read`/`edit`.

## Statistics

Every read/edit-class tool result — built-in **and** hashline — is recorded to
`~/.pi/agent/hashline-stats.json` (atomic temp-file + rename; corrupt/missing
file tolerated). Events go into the `active` bucket when hashline is on at the
time, `inactive` otherwise (the native-edit baseline). Schema:

```jsonc
{
  "version": 1,
  "active":   { /* Counters */ },
  "inactive": { /* Counters */ },
  "recent": [ { "ts", "tool", "path", "isError", "kind" } ]  // bounded to last 500
}
```

Each `Counters` bucket:

```jsonc
{
  "edit_calls": 0,
  "edit_successes": 0,
  "edit_failures": 0,
  "hash_mismatch_rejections": 0,  // hashline_edit anchor mismatches
  "read_calls": 0,
  "firstSeen": null,              // ISO timestamp
  "lastUpdated": null             // ISO timestamp
}
```

`recent[].kind` is `"edit" | "read" | "hash_mismatch"`.
