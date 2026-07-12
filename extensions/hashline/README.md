# hashline

Content-hash-anchored file reading and editing for the pi coding agent, plus always-on usage statistics. Line numbers are a fragile edit anchor — the file can change between read and edit. hashline gives every line a short content hash and requires edits to cite `line:hash`; if the hash has drifted at apply time the **entire edit is rejected** with an actionable diff, so the model re-reads instead of corrupting the file. A minimal reimplementation of the idea from [the harness problem](https://blog.can.ac/2026/02/12/the-harness-problem/).

## Configuration

No configuration file. The only setting is the on/off toggle:

```jsonc
// ~/.pi/agent/hashline.json (written by the /hashline command)
{ "enabled": false }   // boolean, default false
```

The minimum configuration is: none — install and run `/hashline` to enable.

### Configuration Details

- `enabled` — persisted automatically when you run `/hashline`; loaded at session start. A missing or corrupt file falls back to the default (off).

## Provides

- `hashline_read` tool — reads a file as `LINENUM:HASH|CONTENT` rows (e.g. `11:a3f|function hello() {`). Accepts `path` (required), `offset` (1-based start line), `limit` (max lines).
- `hashline_edit` tool — applies `{ path, operations: [...] }`:

  | op              | fields                                            | meaning |
  |-----------------|---------------------------------------------------|---------|
  | `replace`       | `line`, `hash`, optional `to:{line,hash}`, `body` | replace a line or `line..to` range |
  | `insert_before` | `line`, `hash`, `body`                            | insert before the anchored line |
  | `insert_after`  | `line`, `hash`, `body`                            | insert after the anchored line |
  | `insert_head`   | `body`                                            | prepend to the file |
  | `insert_tail`   | `body`                                            | append to the file |
  | `delete`        | `line`, `hash`, optional `to:{line,hash}`         | delete a line or `line..to` range |

- `/hashline` command — toggles the extension on/off; state persists across restarts. When off, the tools defer the model to the built-in `read`/`edit`.

## Limitations and Technical details

- Off by default; enable with `/hashline`.
- The hash is the first 3 hex chars of the SHA-1 of the exact (LF-normalized, BOM-stripped) line text. Whitespace is significant — a trailing-space change changes the hash.
- `body` is an array of lines with no trailing newlines. All operations address **original** line numbers (not applied incrementally); overlapping operations are rejected. Any stale anchor rejects the whole edit with ±2 lines of current context (with real hashes) in the error.
- Output is written with LF endings, preserving the file's original trailing-newline state.
- Statistics: every read/edit-class tool result — built-in **and** hashline — is recorded to `~/.pi/agent/hashline-stats.json` (atomic temp-file + rename; corrupt/missing file tolerated), even while hashline is off. Events land in the `active` bucket when hashline was on at the time, `inactive` otherwise, so the native-edit baseline accumulates for comparison. Each bucket counts `edit_calls`, `edit_successes`, `edit_failures`, `hash_mismatch_rejections`, `read_calls` plus `firstSeen`/`lastUpdated`; a `recent` list keeps the last 500 events (`ts`, `tool`, `path`, `isError`, `kind: "edit" | "read" | "hash_mismatch"`).
