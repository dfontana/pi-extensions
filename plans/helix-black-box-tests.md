# Helix Mode Black-Box Test Plan

## Context

The `extensions/helix-mode/` extension wraps Pi's `CustomEditor` to add Helix-style modal editing. The reported issue is end-user-visible word-wrap behavior: after entering enough text to wrap, placing the cursor in the middle of the first visual line and deleting characters one-by-one shortens that line, but the following visual line does not wrap back up even when there is room. The tests should capture what the user sees, not private implementation state.

Codebase findings:

- `HelixEditor` is the integration point to test: `extensions/helix-mode/editor.ts`.
- Single-character normal-mode delete (`d` with no active selection) delegates to the parent editor via `super.handleInput(SEQ.deleteForward)`.
- Selection delete computes a full replacement string with `deleteRange()`, calls `this.setText(newText)`, then navigates to the target cursor. This difference makes repeated-delete vs selection-delete a useful regression comparison.
- Pi's base `Editor` exposes public `setText()`, `getText()`, `getLines()`, `getCursor()`, `handleInput()`, and `render(width)`.
- `render(width)` is the right black-box surface for wrapping assertions because it is the public component output that feeds the TUI display. Tests should normalize ANSI/cursor-marker noise, but otherwise assert rendered body lines.
- There is currently no `package.json`, test runner, tsconfig, or existing tests in this repo. A repo-level test framework should be introduced.
- I did not find public mouse/click handling in the installed `@earendil-works/pi-tui` package, so tests should reproduce “click into the middle” by deterministic keyboard input: seed/type text, enter normal mode, jump to line start (`0`), then move right to the target logical column.

## Approach

Add a repo-level TypeScript test setup and a black-box harness for `HelixEditor`.

Use Node's built-in `node:test` with `tsx` for TypeScript execution:

- It is lightweight and does not require a larger framework.
- It supports ESM TypeScript tests via `node --import tsx --test`.
- It keeps assertions close to public behavior and avoids mocking internals.

Test strategy:

1. Instantiate `HelixEditor` with lightweight mocks for `TUI`, `EditorTheme`, app theme, and keybindings.
2. Seed text through public behavior:
   - use `setText()` when the scenario is about editing an existing buffer;
   - use `handleInput()` character-by-character when the scenario specifically needs typed input behavior.
3. Place the cursor only through public inputs (`Escape`, `0`, `l`/right, word motions, etc.); do not add a test-only cursor setter.
4. Drive edits through `editor.handleInput()` using real key sequences and Helix commands.
5. Assert what a user can observe:
   - normalized `editor.render(width)` body lines for wrapped visual output;
   - `editor.getText()` and `editor.getCursor()` as secondary public sanity checks.
6. Prefer scenario/table-driven tests that compare workflows that should be visually equivalent:
   - repeated single-character deletes;
   - deleting the same span through select mode.

## Files to modify

- `package.json`
  - Add an `npm test` script that runs `node --import tsx --test "extensions/**/*.test.ts"`.
  - Add an optional `typecheck` script using `tsc --noEmit`.
  - Add dependencies/devDependencies needed for local test execution: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `tsx`, `typescript`, and `@types/node`.
- `tsconfig.json`
  - Configure ESM/NodeNext TypeScript for extension tests (`module`/`moduleResolution: "NodeNext"`, `target` at least ES2022, `strict`, `noEmit`, `skipLibCheck`).
- `extensions/helix-mode/__tests__/test-harness.ts`
  - Create mocked TUI/theme/keybinding helpers.
  - Provide input and render-normalization helpers.
- `extensions/helix-mode/__tests__/helix-editor.blackbox.test.ts`
  - Main behavior tests for `HelixEditor` using only public APIs.
- Optional later split: `extensions/helix-mode/__tests__/word-wrap-regressions.test.ts`
  - Move render-heavy regression cases here if the main test file becomes too large.

## Reuse

Existing code and APIs to reuse:

- `HelixEditor` from `extensions/helix-mode/editor.ts` as the subject under test.
- Public parent editor APIs: `setText()`, `getText()`, `getLines()`, `getCursor()`, `handleInput()`, `render(width)`.
- `KeybindingsManager`, `TUI_KEYBINDINGS`, and `setKeybindings()` from `@earendil-works/pi-tui` for realistic default editor key matching in tests.
- Key sequences already used by `editor.ts`, mirrored in tests as black-box inputs:
  - Escape: `\x1b`
  - Left/right/up/down: `\x1b[D`, `\x1b[C`, `\x1b[A`, `\x1b[B`
  - Delete forward: `\x1b[3~`
  - Ctrl+A / Ctrl+E: `\x01`, `\x05`
- Existing pure helpers in `buffer.ts` and `selection.ts` can have separate pure unit tests later, but the black-box editor suite should not use them as the oracle for rendered output.

Suggested harness helpers:

- `createEditor({ rows = 24 } = {})`: returns `{ editor, tui }`; `tui.requestRender()` increments a counter for optional assertions.
- `press(editor, ...keys)`: calls `handleInput()` for each key.
- `typeText(editor, text)`: sends printable characters one at a time.
- `enterNormal(editor)`: sends Escape.
- `moveToCol(editor, col)`: sends `0` then `l`/right `col` times in normal mode.
- `stripAnsiAndCursor(line)`: removes ANSI escape sequences and `CURSOR_MARKER`.
- `renderBody(editor, width)`: calls `render(width)`, strips ANSI/cursor markers, removes top/bottom borders, and trims right padding from body lines.

## Candidate test cases

### Priority 1: reported re-wrap regression

- **Repeated delete reflows following visual line upward**
  - Seed a single long logical line, e.g. a sentence of short words that wraps at a narrow width.
  - Render once at a fixed width to establish the initial wrapped body.
  - Enter normal mode, move to a column in the middle of the first visual line, press `d` repeatedly.
  - After each delete, assert `renderBody(editor, width)` equals the expected visual rows, including words from the next visual line moving up as space opens.

- **Repeated delete and selection delete converge visually**
  - Create two editors with the same text, width, and cursor placement.
  - Editor A: delete N characters via `d` repeated N times.
  - Editor B: enter select mode (`v`), extend the selection over the same N characters with `l`/right, then press `d`.
  - Assert identical `getText()`, `getCursor()`, and `renderBody(width)`.
  - This directly guards the current suspicious split between `super.handleInput(deleteForward)` and `setText(newText)`.

- **Deleting at a wrap opportunity pulls next word up**
  - Put the cursor on or just before a space near a wrap boundary.
  - Press `d` once or a few times.
  - Assert the rendered body reflects immediate re-wrapping, not stale visual chunks.

- **Deleting inside a word near a wrap boundary reflows hard-wrap boundaries**
  - Use a line with at least one long-ish word near the boundary.
  - Delete characters within that word.
  - Assert the rendered chunks change immediately and consistently.

### Priority 2: deletion/editing semantics around wrapping

- **Normal `d` with no selection deletes one grapheme and remains in normal-like behavior**
  - Verify next printable key is swallowed until insert mode is re-entered.
- **Select-mode `d` deletes an inclusive selection and exits selection behavior**
  - Verify the rendered output and next printable key behavior.
- **`c` deletes selection and enters insert mode**
  - After `c`, send printable text and assert it inserts at the deletion point.
- **`r<char>` replaces the character under cursor**
  - Include a wrapped-line case so render output changes are asserted.
- **End-of-logical-line `d` merges lines and rewraps**
  - Cursor at the end of one logical line; `d` deletes the newline and renders the merged logical line with fresh wrapping.

### Priority 3: navigation/cursor cases that keep wrap tests stable

- **`0`/`$` operate on logical line start/end**, independent of visual rows.
- **`w`/`b`/`e` navigate by logical text**, not visual wraps, on a long wrapped line.
- **`gg`/`ge` navigate to buffer start/end** with wrapped long lines.
- **Select-mode movement extends selection across wrapped visual rows** and delete removes the intended logical range.

### Priority 4: Unicode/grapheme coverage

- **Single delete removes one grapheme** for emoji/combining characters and re-wraps afterward.
- **Wide CJK/emoji characters render within width constraints after deletion**.

## Steps

- [x] Add repo-level test tooling in `package.json` and `tsconfig.json`.
- [x] Add the `extensions/helix-mode/__tests__/test-harness.ts` helper module.
- [x] Implement render normalization that reflects user-visible body lines while stripping ANSI, cursor markers, borders, and right padding.
- [x] Add the priority-1 re-wrap regression tests first, especially repeated-delete vs selection-delete convergence.
- [x] Add priority-2 delete/change/replace tests that assert both rendered output and public buffer/cursor state.
- [x] Add priority-3 navigation tests only as needed to keep the black-box cursor-placement assumptions well covered.
- [x] Add priority-4 Unicode/grapheme tests after the ASCII regression cases are stable.
- [x] Keep tests robust to refactors by never reading private fields or calling private methods such as `navigateTo()`.

## Verification

- Run `npm test`.
- Run `npm run typecheck` if the typecheck script is added.
- Confirm at least one priority-1 test fails against the current reported behavior before any production-code fix, then passes after the fix.
- Manually reproduce in Pi using the same fixture text, width, cursor placement, and delete sequence used by the failing/passing regression test.
- Confirm the test suite can run from a fresh checkout after installing dependencies, without relying on globally installed Pi packages.
