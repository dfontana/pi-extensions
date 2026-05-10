# Plan: Helix Mode Extension

## Context

Pi's TUI input box is a plain insert-mode editor. Power users who come from Helix want modal editing with selection-first semantics: Normal mode for navigation and manipulation, Select/extend mode to build up ranges, and a `*`-based find workflow for rapid text traversal. The goal is a pi extension that wraps the input editor in a faithful-enough subset of Helix's modal editing without needing to replace pi's text engine entirely.

The most important features (per task description):
- Normal / Select / Insert mode switching
- Selection manipulation (`s`)
- `*` / `/` search workflow with `n`/`N` navigation
- `gw` jump-to-word (jump-by-label), which compensates for the absence of true multi-cursor

## Approach

Extend `CustomEditor` (pi's modal editing hook) with a `HelixEditor` class. `CustomEditor` gives access to the underlying `Editor`'s public methods (`getText()`, `getLines()`, `getCursor()`, `setText()`, `insertTextAtCursor()`) and lets us intercept all keypresses before they reach the built-in editor. Mode state, search state, and selection state are tracked in the subclass; most actions are implemented by reading the buffer, computing a transformation, and calling `setText()` + cursor navigation key sequences, or by translating keys to escape sequences for the built-in editor to handle.

The extension:
1. Installs `HelixEditor` via `ctx.ui.setEditorComponent()` on `session_start`
2. Exposes a `/helix [on|off]` command to toggle; defaults to on
3. Renders the mode label (`NORMAL` / `INSERT` / `SELECT`) in the bottom editor border

## Architecture

### Mode State Machine

```
           ESC                    v
INSERT ──────────► NORMAL ◄────────── SELECT
  ▲                  │ i/a/I/A/o/O     ▲
  └──────────────────┘                 │
                                       │ (via v, or movement in select mode)
```

- **Insert** → default; all keystrokes pass to `super.handleInput()`
- **Normal** → intercepts keystrokes; `Escape` in Normal passes to super (abort agent / pi's normal escape behavior)
- **Select/extend** → like Normal movement but extends selection anchor; `Escape` → Normal

### Buffer Access Strategy

`Editor` (grandparent class) exposes:
- `getText(): string` — full buffer
- `getLines(): string[]` — logical lines
- `getCursor(): { line, col }` — logical cursor (0-indexed)
- `setText(text)` — replace full buffer (cursor resets to 0,0)
- `insertTextAtCursor(text)` — insert at current position

Cursor positioning is done by emitting cursor-movement key sequences to `super.handleInput()`:
```typescript
private navigateTo(targetLine: number, targetCol: number): void {
  const { line, col } = this.getCursor();
  const lineDelta = targetLine - line;
  // emit Up/Down arrows for line delta
  // emit Ctrl+A (line start) + Right arrows for column
}
```

`setText()` leaves cursor at `{0, 0}`, so after any `setText()` call, `navigateTo(targetLine, targetCol)` is called to restore the cursor.

### Selection Tracking

The "selection" is defined by an anchor + the current cursor (anchor can be behind or ahead of cursor). For Normal mode operations that consume a selection (`d`, `c`, `s`), selection bounds are resolved from `selectionAnchor` + `getCursor()`. Helix uses inclusive selection (both ends included).

In **Select mode**, every movement key extends the selection (anchor stays, cursor moves). The mode label includes a char count: `SELECT (12)`.

Visual selection highlighting is not rendered inline (requires ANSI-aware character replacement at arbitrary visual positions in rendered output — out of scope). The char-count in the border label serves as selection feedback.

## Files to Create

| File | Purpose |
|---|---|
| `extensions/helix-mode/index.ts` | Extension entry point; registers session_start event + /helix command |
| `extensions/helix-mode/editor.ts` | `HelixEditor` class — all modal logic |
| `extensions/helix-mode/buffer.ts` | Pure helpers: `offsetToLineCol`, `lineColToOffset`, `findWordStarts`, `findMatches`, `applyRegex` |
| `extensions/helix-mode/label-overlay.ts` | `gw` jump logic: label assignment, overlay line rendering |

## Reuse

- `CustomEditor` from `@earendil-works/pi-coding-agent` — base class with app keybindings, text editing engine
- `Editor` (via `CustomEditor`) — `getText()`, `getLines()`, `getCursor()`, `setText()`, `insertTextAtCursor()`
- `matchesKey`, `truncateToWidth`, `visibleWidth` from `@earendil-works/pi-tui` — key matching and ANSI-safe string ops
- `border-status-editor.ts` example — pattern for injecting labels into the bottom border line
- `modal-editor.ts` example — pattern for mode switching + escape-sequence translation
- `ctx.ui.setEditorComponent()` — factory pattern for installing the custom editor
- `ctx.ui.setStatus()` — show mode indicator in footer (supplementary to border label)

## Normal Mode Bindings (In Scope)

### Movement → translated to escape sequences / keybinding invocations

| Key | Action | Sequence |
|---|---|---|
| `h` / `Left` | char left | alias: both emit `\x1b[D` |
| `l` / `Right` | char right | alias: both emit `\x1b[C` |
| `j` / `Down` | line down | alias: both emit `\x1b[B` |
| `k` / `Up` | line up | alias: both emit `\x1b[A` |
| `w` | word right | `\x1b[1;5C` (Ctrl+Right) |
| `b` | word left | `\x1b[1;5D` (Ctrl+Left) |
| `e` | word end | implemented as `w` then back-one |
| `0` / `Home` | line start | `\x01` (Ctrl+A) |
| `$` / `End` | line end | `\x05` (Ctrl+E) |

### Two-key prefix: `g`

| Sequence | Action |
|---|---|
| `g` + `g` | go to buffer start (`navigateTo(0, 0)`) |
| `g` + `e` | go to buffer end (`navigateTo(lastLine, lastCol)`) |
| `g` + `w` | enter **label jump mode** (see `gw` section) |

### Mode Entry

| Key | Action |
|---|---|
| `i` | Insert before selection |
| `a` | Insert after selection (cursor right, then Insert) |
| `o` | Open line below (move to end, enter, Insert) |
| `O` | Open line above (move to start, open new line above, Insert) |
| `v` | Enter Select mode (save anchor) |

### Changes (operate on selection or char under cursor)

| Key | Action | Implementation |
|---|---|---|
| `d` | Delete selection | `getText()` → splice out selection range → `setText()` + cursor |
| `c` | Change (delete + Insert) | same as `d`, then enter Insert |
| `r` + char | Replace char under cursor | delete-forward, insert char |
| `x` | Select line (extend if already line-selected) | extend selection to full line bounds |
| `>` | Indent selected lines | prepend spaces/tab to each selected line via `setText()` |
| `<` | Unindent selected lines | remove leading indent from each selected line via `setText()` |

### Selection Manipulation

| Key | Action | Implementation |
|---|---|---|
| `s` | Select regex matches within selection | prompt for regex (mini inline input), then select first match; `n`/`N` navigate |

### Search

| Key | Action | Implementation |
|---|---|---|
| `*` | Selection → search pattern (word-boundary) | `buildSearchMatches(wrapWord(selectionText))`, navigate to first |
| `/` | Enter search pattern | inline mini-prompt; on confirm: `buildSearchMatches(pattern)` |
| `n` | Next match | `currentMatchIdx++`, `navigateTo(match)` |
| `N` | Previous match | `currentMatchIdx--`, `navigateTo(match)` |

### Select Mode

Select mode shadows Normal mode movement keys but extends the selection instead of just moving. `Escape` returns to Normal (keeps selection). All the selection manipulation and change keys work the same.

## `gw` — Jump to Word by Label

When `g` + `w` is pressed:

1. `labelMode = true`; call `tui.requestRender()`
2. **`buildLabelMap()`**: call `getLines()`, use `wordWrapLine(line, width)` (exported from `@earendil-works/pi-tui`) to reconstruct the visual layout. For each word-start in each logical line, compute visual `(row, visualCol)`. Assign labels `a-z A-Z` (52 max) in reading order. Store as `Map<string, {visualRow, visualCol}>`.
3. **`render()` override in label mode**:
   - Call `super.render(width)` → base rendered lines with ANSI codes
   - Strip ANSI from each content line (regex-based) → plain visible text
   - For each label entry: replace the character at `(visualRow, visualCol)` in the stripped plain text with the label character, wrapped in bold + red (`\x1b[1;31m<label>\x1b[0m`)
   - Return the relabeled lines (cursor position and editor styling hidden for the ~1 keypress duration — acceptable)
4. Next keypress: if it matches a label, call `navigateTo(labelMap[key])` and clear `labelMode`; if `Escape`, cancel

`label-overlay.ts` implements: `buildLabelMap(lines, width)` and `applyLabels(renderedLines, labelMap)`. The ANSI stripping + char replacement is ~50 lines.

## Mini Prompt (for `/` search and `s`)

For keys that need user input in Normal mode (`/` and `s`), a lightweight inline prompt is shown in the bottom border area:
- `pendingInput = { type: "search" | "select", buffer: "" }`
- In `render()`: replace bottom border content with `/ <buffer>█` (or `s/ <buffer>█`)
- Keypresses go into `pendingInput.buffer` until `Enter` (confirm) or `Escape` (cancel)
- On confirm: run `buildSearchMatches(buffer)` or selection operation

This avoids launching a full overlay dialog and keeps the interaction snappy and in-place.

## Mode Indicator

The bottom border line of the editor is extended (same pattern as `border-status-editor.ts`):

```typescript
render(width: number): string[] {
  const lines = super.render(width);
  if (lines.length === 0) return lines;
  
  const label = this.getModeLabel(); // " NORMAL " | " INSERT " | " SELECT (N) "
  const last = lines.length - 1;
  lines[last] = truncateToWidth(lines[last]!, width - visibleWidth(label), "") 
                + theme.fg("accent", label);
  return lines;
}
```

Colors: NORMAL → `accent`, INSERT → `dim`, SELECT → `warning`.

## Toggle Command

```typescript
pi.registerCommand("helix", {
  description: "Toggle Helix modal editing mode [on|off]",
  handler: (args, ctx) => {
    const arg = args.trim().toLowerCase();
    if (arg === "off" || helixEnabled) {
      helixEnabled = false;
      ctx.ui.setEditorComponent(undefined); // restore default
      ctx.ui.notify("Helix mode off", "info");
    } else {
      helixEnabled = true;
      ctx.ui.setEditorComponent((tui, theme, kb) => new HelixEditor(tui, theme, kb));
      ctx.ui.notify("Helix mode on", "info");
    }
  }
});
```

Default state: on (installed at `session_start`).

## Implementation Steps

- [ ] **1. Create `extensions/helix-mode/buffer.ts`** — pure functions: `lineColToOffset(lines, line, col)`, `offsetToLineCol(text, offset)`, `findWordStarts(text)`, `findMatches(text, pattern)`. No Pi dependencies; fully unit-testable.
- [ ] **2. Create `extensions/helix-mode/label-overlay.ts`** — `buildLabelMap(lines, width): Map<string, {visualRow, visualCol}>` using `wordWrapLine`, and `applyLabels(renderedLines, labelMap): string[]` for inline bold-red label injection.
- [ ] **3. Create `extensions/helix-mode/editor.ts`** — `HelixEditor extends CustomEditor`:
  - [ ] 3a. Mode state + `enterNormal()`, `enterInsert()`, `enterSelect()` + border label rendering
  - [ ] 3b. `handleInput()` dispatch + Insert mode pass-through
  - [ ] 3c. Normal mode movement keys (h/j/k/l + arrow aliases, w/b/e, 0/$, g-prefix)
  - [ ] 3d. `navigateTo(line, col)` helper using key sequences
  - [ ] 3e. Mode entry keys (i/a/o/O/v)
  - [ ] 3f. Changes: d/c/r/x
  - [ ] 3g. Indent/unindent: >/<
  - [ ] 3h. Selection manipulation: `s`
  - [ ] 3i. Search: `*`/`/`/`n`/`N`
  - [ ] 3j. Mini prompt for `/` and `s`
  - [ ] 3k. `gw` label jump mode
  - [ ] 3l. Select mode movement extensions
- [ ] **4. Create `extensions/helix-mode/index.ts`** — extension entry point: `session_start` installs editor; `/helix` command toggles; `session_shutdown` cleans up.
- [ ] **5. Update `README.md`** — document the extension, available modes, key bindings cheatsheet.

## Verification

1. Start pi with the extension loaded. Confirm `INSERT` label appears in editor bottom border.
2. Press `Escape` → border changes to `NORMAL`. Press `i` → back to `INSERT`.
3. In Normal mode: type `hjkl` — cursor moves (not text inserted).
4. Type text in Insert, press `Escape`, then `w`/`b` — cursor jumps by word.
5. Press `v` → `SELECT (0)` label. Press `l` several times → char count increases in label.
6. In Normal mode with cursor on a word: press `*` → `n`/`N` navigate to next/prev matches.
7. Press `/` → border shows `/ █`. Type a pattern, `Enter` → `n`/`N` navigate matches.
8. Press `gw` → labels appear inline over word-start characters (bold red). Type a label → cursor jumps.
9. Press `d` with a selection → selection text is deleted.
10. Press `>` with multi-line selection → each selected line gains indentation.
11. Run `/helix off` → default editor restored (no mode label, normal keybindings).
12. Run `/helix on` → Helix editor re-installed, starts in Insert mode.

## Known Limitations / Future Work

- **No true multi-cursor**: `*` + `n/N` navigates matches one at a time. Simultaneous editing of all matches would require a custom text buffer replacing the built-in editor engine entirely.
- **Selection highlighting**: Selection range not visually highlighted in the editor text (only the char-count in the mode label). Visual highlight requires ANSI-aware string manipulation at arbitrary visual positions.
- **No clipboard yank**: Without named registers, `y` is not implemented; use system-level copy (select text + terminal copy).
- **Count prefixes**: `3w`, `5j` etc. are out of scope for v1.
- **Macros, match-mode, shell commands**: Explicitly out of scope.
