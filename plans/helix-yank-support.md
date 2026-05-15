# Helix Mode Yank Support Plan

## Context

- User wants `y` support in `extensions/helix-mode/` so the current selection is copied/yanked to the system clipboard.
- Current README explicitly lists “No clipboard yank (`y`)” as a known limitation.
- `HelixEditor` already has Select mode, selection helpers, and `selectionText()` for extracting the current inclusive selection.

## Approach

- Add a Normal/Select mode `y` binding in `HelixEditor.handleNormalInput()`.
- Implement an `actionYank()` helper that only acts when `this.selection` exists and `getSelectionInfo(...).isNonEmpty` is true; otherwise `y` is a no-op.
- Copy the selected text to the system clipboard without modifying the editor buffer.
- Reuse existing selection normalization/extraction helpers to preserve current inclusive selection semantics.
- Add `extensions/helix-mode/clipboard.ts` with a small `writeSystemClipboard(text)` helper. Node does not provide a standard-library system clipboard API, and this TUI extension should not add a new dependency/install step, so the helper will use OS clipboard commands via `child_process.execFile`.
- Clipboard command selection will be deterministic and runtime-detected:
  - Build an ordered candidate list from `process.platform` and environment variables.
  - `darwin` → `pbcopy`.
  - `win32` → `clip.exe`.
  - Linux with `WAYLAND_DISPLAY` → try `wl-copy` first.
  - Linux with `DISPLAY` → try `xclip -selection clipboard`, then `xsel --clipboard --input`.
  - WSL-like environments (`WSL_DISTRO_NAME`/`WSL_INTEROP`) → include `clip.exe` as a fallback.
  - Attempt candidates in order; `ENOENT`/non-zero exit/timeout falls through to the next candidate. Return success only after a command accepts the selected text on stdin.
- Keep UX simple: after a successful yank, return to Normal mode, clear the selection, and request a render. If clipboard access fails, leave the current selection/mode intact and request a render; do not mutate the buffer.
- Update documentation/comments to advertise `y` and remove the known limitation.

## Files to modify

- `extensions/helix-mode/editor.ts`
- `extensions/helix-mode/index.ts`
- `README.md`
- `extensions/helix-mode/clipboard.ts`

## Reuse

- `selectionText()` from `extensions/helix-mode/selection.ts` to extract selected text.
- `getSelectionInfo()` from `extensions/helix-mode/selection.ts` to detect non-empty selections consistently with delete/change.
- Existing `actionDelete()` and `actionChange()` patterns in `extensions/helix-mode/editor.ts` for where to place the new action.
- Existing mode transition/render helpers (`enterNormal()`, `tui.requestRender()`) in `extensions/helix-mode/editor.ts`.

## Steps

- [x] Confirm expected behavior for `y` when there is no active/non-empty selection: no-op.
- [x] Add `clipboard.ts` with `writeSystemClipboard(text)` using platform/env-based candidate selection, command fallback attempts, stdin writing, timeout handling, and Promise-based success/failure.
- [x] Add a `y` key branch in Normal/Select handling before the printable-character swallow path, following existing change-action placement.
- [x] Implement `actionYank()` using `getSelectionInfo()` and `selectionText()`; return immediately when there is no active non-empty selection.
- [x] On successful yank, clear selection and enter Normal mode without changing buffer contents; on failure, preserve selection/mode for retry.
- [x] Update comments/key-feature lists and README key tables/known limitations.
- [x] Run TypeScript/static checks if available, or at least perform a syntax-oriented review.

## Verification

- Manual editor behavior:
  - Type text, press `Esc`, enter Select mode with `v`, extend selection, press `y`, and paste into an external app/shell to confirm the exact selected text was copied.
  - Verify the buffer contents are unchanged after yank.
  - Verify Select mode exits to Normal after a successful yank.
  - Verify `y` with no selection is a no-op: it does not insert `y`, copy a character/line, or corrupt state.
  - On the current OS, verify the expected clipboard command path works; if that command is absent, verify failure preserves the selection/mode and does not modify the buffer.
- Static verification:
  - Run the repository’s available typecheck/test command if one exists.
  - If no project test command exists, inspect TypeScript imports and runtime APIs for compatibility.
