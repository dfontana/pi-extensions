# Handoff: ast-grep tool for pi

**Date:** 2026-06-16
**Status:** Design complete, implementation not started. Ready to build.
**Goal:** A production-grade pi extension that registers an `ast_grep` tool (like the built-in `grep`/`edit`) backed by [ast-grep](https://ast-grep.github.io).

---

## 1. Context & research done this session

- Read pi 0.79.6 extension docs in full: `~/.local/share/mise/installs/pi/0.79.6/docs/extensions.md`
  (custom tools, `registerTool`, `withFileMutationQueue`, truncation utils, rendering, overriding built-ins).
- Studied the built-in `grep.ts` source (fetched from the pi-mono repo) end to end: schema,
  `GrepToolDetails` shape, `rg --json` spawning, streaming readline parse, match-limit early-kill,
  `truncateHead`/`truncateLine`, `formatGrepCall`/`formatGrepResult` rendering with `lastComponent` reuse.
- Studied example `examples/extensions/truncated-tool.ts` (a from-scratch `rg` wrapper with custom
  `renderCall`/`renderResult`) and `examples/extensions/tool-override.ts`.
- Read ast-grep CLI reference (`sg run` / `sg scan` flags, `--json=stream` output shape, YAML rules,
  meta-variable dialect `$A` / `$$$ARGS`, exit codes).
- Probed the local environment (see §6).

## 2. Viability verdict: HIGH

pi's extension API is purpose-built for this. The built-in `grep` is itself a CLI wrapper around `rg`
(spawn → parse JSON stream → limit → truncate → render). An ast-grep tool is the same shape, plus an
optional rewrite mode that mirrors `edit`. Every required primitive exists:

- TypeBox schemas, `promptSnippet`/`promptGuidelines` for system-prompt teaching
- `signal`-aware child spawning + early kill
- `truncateHead`, `DEFAULT_MAX_BYTES` (50KB), `DEFAULT_MAX_LINES`, `truncateLine`, `formatSize`
- `withFileMutationQueue(absPath)` for safe file mutation (mirrors `edit`/`write`)
- `renderCall`/`renderResult` with `context.lastComponent` reuse, `keyHint`, expand support

## 3. Environment facts (verified)

- pi: 0.79.6 (mise), docs/examples at `~/.local/share/mise/installs/pi/0.79.6/`.
- **ast-grep is NOT installed.** No `ast-grep` on PATH, no mise plugin.
- `/usr/bin/sg` is **shadow-utils `newgrp`**, NOT ast-grep. ⚠️ Never invoke bare `sg`.
- `cargo` 1.96.0 available → `cargo install ast-grep` is the fastest reliable install.
- `npm`/`npx` available → `@ast-grep/cli` v0.43.0 on npm.
- Repo cwd: `~/code/pi-extensions`.

## 4. Proposed design

### Tool: `ast_grep` (one tool, two modes)

| Param | Type | Notes |
|---|---|---|
| `mode` | `"search" \| "rewrite"` (default `search`) | `StringEnum` for Google compat |
| `pattern` | string (required) | ast-grep pattern, e.g. `console.log($$$ARGS)` |
| `rewrite` | string? | replacement pattern; required in rewrite mode |
| `lang` | string? | `TypeScript`/`JavaScript`/`Rust`/`Python`/...; inferred from extension if omitted |
| `path` | string? | file or dir, default cwd; **single file required for rewrite mode** |
| `glob` | string? | include glob; `!excl` to exclude |
| `strictness` | enum? | `cst\|smart\|ast\|relaxed\|signature\|template` |
| `context` | number? | lines around each match (`-C`) |
| `limit` | number? | max matches, default 100 (mirror grep) |

### Search mode

Spawn `ast-grep run -p <pattern> -l <lang> --json=stream --heading=never --color=never
[--globs ...] [-C <n>] <path>`, stream-parse NDJSON. Each match object has
`{file, lines, range:{start:{line,column}}, text, replacement?, metaVariables}`.

Format output like grep: `relativePath:lineNumber: text` for matches, `relativePath-lineNumber- text`
for context. Apply `truncateLine` per line, `truncateHead` overall, enforce `limit` with early child
kill. Exit code 1 = no matches (treat as "No matches found", not an error — same as `rg`).

### Rewrite mode (mutation-safe)

1. Resolve `path` to absolute; require it to be a single existing file (throw otherwise).
2. `withFileMutationQueue(absolutePath, async () => { ... })` — entire read/apply window queued.
3. Dry-run first: `ast-grep run -p <pattern> -r <rewrite> --json=stream <file>` to enumerate matches
   and confirm replacements are well-formed.
4. Apply: either reuse the dry-run output to rewrite in-process, or run
   `ast-grep run -p <pattern> -r <rewrite> -U <file>` under the queue.
5. Return a compact before/after (unified-diff-style or trimmed snippets) so the LLM sees the change,
   plus match count and whether anything changed.

**Tree-wide rewrite is deferred** (later opt-in behind a flag) to avoid races with concurrent
`edit`/`write` calls — `withFileMutationQueue` is per-file, so a single in-place `ast-grep -U` across
a tree would not serialize against other tools touching the same files.

### Rendering

Mirror built-in grep exactly so it feels native:
- `renderCall`: `ast_grep /pattern/ in path (glob) [lang] [mode]` with `theme.fg("toolTitle", bold(...))`.
- `renderResult`: first 15 lines (all if expanded) in `theme.fg("toolOutput", ...)`, truncation/match-limit
  warnings in `theme.fg("warning", ...)` with `keyHint("app.tools.expand", ...)` for overflow.
- Reuse `context.lastComponent as Text` and `setText(...)`.

### Prompt teaching (critical — #1 usability risk)

The LLM does not know ast-grep's pattern dialect. Provide:
- A crisp `description` with the meta-variable rules: `$A` = single node, `$$$ARGS` = multiple,
  matched structurally (not textually).
- 2–3 inline examples per common language.
- `promptSnippet`: "Structural search/rewrite code by AST pattern (ast-grep)".
- `promptGuidelines` naming the tool explicitly (per docs: bullets are appended flat, no tool prefix):
  - "Use ast_grep (not grep) when matching code structure: function calls, imports, specific syntax
    shapes. Use grep for plain text/regex."
  - "In ast_grep, patterns are structural: `console.log($$$ARGS)` matches any console.log call;
    `$A && $A()` matches a repeated expression."
  - "For ast_grep rewrite, pass a single file as path; the tool queues the mutation safely."

## 5. Production-critical risks & mitigations

| Risk | Mitigation |
|---|---|
| `sg` binary collision with `newgrp` | Resolver invokes `ast-grep` explicitly; never bare `sg`. |
| ast-grep not installed | Robust resolver: PATH (`ast-grep`) → `npx @ast-grep/cli` → clear error. Optional bootstrap via `cargo install ast-grep` or `npm i -g @ast-grep/cli` behind a flag/one-time setup. |
| Rewrite races with concurrent `edit`/`write` | Per-file constraint + `withFileMutationQueue`; no tree-wide rewrite in v1. |
| LLM emits broken patterns | Strong description + `promptGuidelines` examples; on ast-grep parse error, surface the CLI's error text verbatim so the LLM can self-correct. |
| Language inference ambiguity | Accept either short (`ts`) or long (`TypeScript`) forms via a lang map; default to inferring from extension when `path` is a file. |
| Output blowup | Reuse `truncateHead`/`truncateLine`/`DEFAULT_MAX_BYTES`; save full output to temp file when truncated (as `truncated-tool.ts` does). |

## 6. Open decisions (need user input before/during build)

1. **Install strategy** — (a) require ast-grep pre-installed, error clearly if missing; (b) add a
   one-time `cargo install ast-grep` bootstrap; or (c) `npm i -g @ast-grep/cli`.
   *Recommended:* resolver checks PATH, then `npx @ast-grep/cli` as fallback; offer a
   `/ast-grep-install` command using cargo for performance.
2. **Rewrite scope** — confirm v1 is single-file only (safe, `edit`-like), tree-wide rewrite deferred.
   *Recommended:* yes.
3. **Tool name** — `ast_grep` (underscore, matches pi convention) vs `astgrep`. *Recommended:* `ast_grep`.

## 7. Placement & structure

```
~/.pi/agent/extensions/ast-grep/   (or .pi/extensions/ast-grep/ project-local)
├── index.ts          # registerTool, modes, rendering, prompt metadata
├── resolver.ts       # binary discovery + optional bootstrap
├── search.ts         # search-mode spawn/parse/format
├── rewrite.ts        # rewrite-mode queue/dry-run/apply/diff
└── package.json      # (if deps needed; none required for v1 — node:child_process + built-ins only)
```

Auto-discovered → hot-reloadable via `/reload`. No npm runtime deps needed for v1 (uses only
`node:child_process`, `node:fs/promises`, `node:path`, `node:os`, plus pi's exported utils).

## 8. References

- pi extensions doc: `~/.local/share/mise/installs/pi/0.79.6/docs/extensions.md` (Custom Tools, Output Truncation, Overriding Built-in Tools, `withFileMutationQueue`)
- built-in grep source: `packages/coding-agent/src/core/tools/grep.ts` in pi-mono
- examples: `examples/extensions/truncated-tool.ts`, `examples/extensions/tool-override.ts`
- ast-grep CLI: https://ast-grep.github.io/reference/cli.html
- ast-grep pattern/rule ref: https://ast-grep.github.io/reference/rule.html

## 9. Next steps

1. Confirm open decisions in §6.
2. Scaffold `ast-grep/` extension dir with the five files above.
3. Implement resolver → search → rendering → rewrite → prompt metadata.
4. Test: `pi -e ./ast-grep/index.ts` with a TS fixture (search for `console.log($$$ARGS)`,
   rewrite to `void $$$ARGS`).
5. Verify mutation safety: run `ast_grep` rewrite + `edit` on the same file in one turn, confirm no lost write.
