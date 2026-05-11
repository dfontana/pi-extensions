# Task 07 — Fix `navigateTo()` in helix-mode

## 1. Current `navigateTo()` implementation

**File:** `extensions/helix-mode/editor.ts`  
**Lines:** ~350–363 (between the `// 3d.` comment block and the g-prefix handler)

```typescript
// ══════════════════════════════════════════════════════════════════════════
// 3d. navigateTo — move cursor to {line, col} via key sequences
// ══════════════════════════════════════════════════════════════════════════

private navigateTo(targetLine: number, targetCol: number): void {
  const { line, col } = this.getCursor();
  const lineDelta = targetLine - line;

  if (lineDelta > 0) {
    for (let i = 0; i < lineDelta; i++) super.handleInput(SEQ.down);
  } else if (lineDelta < 0) {
    for (let i = 0; i < -lineDelta; i++) super.handleInput(SEQ.up);
  }

  // Go to line start, then advance to target column
  super.handleInput(SEQ.lineStart);
  for (let i = 0; i < targetCol; i++) super.handleInput(SEQ.right);

  this.syncSelectionHead();
  this.tui.requestRender();
}
```

**`SEQ` constants used:**
```typescript
const SEQ = {
  left:        "\x1b[D",
  right:       "\x1b[C",
  up:          "\x1b[A",
  down:        "\x1b[B",
  lineStart:   "\x01",   // Ctrl+A  → tui.editor.cursorLineStart
  lineEnd:     "\x05",   // Ctrl+E  → tui.editor.cursorLineEnd
  deleteForward: "\x1b[3~",
} as const;
```

---

## 2. All call sites

| Location in editor.ts | Call | Purpose |
|---|---|---|
| `handleNormalInput` — `"i"` branch | `navigateTo(start.line, start.col)` | Place cursor at selection start before entering Insert |
| `handleNormalInput` — `"a"` branch | `navigateTo(afterEnd.line, afterEnd.col)` | Place cursor one past selection end before entering Insert |
| `handleNormalInput` — `"o"` branch | `navigateTo(line + 1, 0)` | Land on the newly-opened line below (after `insertTextAtCursor("\n")`) |
| `handleNormalInput` — `"O"` branch | `navigateTo(line, 0)` | Land on the newly-opened line above (after content shifts down) |
| `moveWordNext()` | `navigateTo(target.line, target.col)` | Move to next word start |
| `moveWordPrev()` | `navigateTo(target.line, target.col)` | Move to prev word start |
| `moveWordEnd()` | `navigateTo(target.line, target.col)` | Move to next word end |
| `handleGPrefix("g")` | `navigateTo(0, 0)` | `gg` — buffer start |
| `handleGPrefix("e")` | `navigateTo(lastLine, lastCol)` | `ge` — buffer end |
| `handleLabelInput` | `navigateTo(entry.logicalLine, entry.logicalCol)` | `gw` — jump to label |
| `actionDelete()` | `navigateTo(target.line, target.col)` | Restore cursor after delete |
| `actionSelectLine()` | `navigateTo(nextLine, nextLineEnd)` | Extend line selection in Select mode |
| `actionIndent(true/false)` | `navigateTo(newCursorLine, newCursorCol)` | Restore cursor after indent/unindent |
| `actionSelectRegex()` | `navigateTo(endTarget.line, endTarget.col)` | Jump to end of first regex match |
| `navigateMatch()` | `navigateTo(endTarget.line, endTarget.col)` | Jump to end of next/prev search match |

**Total call sites: 15** (across all Helix features: search, `gg`/`ge`, `gw`, `i`/`a`/`o`/`O`, word movement, delete/change, indent, line selection, regex search).

---

## 3. What Pi APIs exist that could replace synthetic keys

### 3.1 Confirmed available on `Editor` / `CustomEditor`

From `@earendil-works/pi-tui/dist/components/editor.d.ts` and its compiled `.js`:

| Method | Behaviour |
|---|---|
| `getText(): string` | Returns current multi-line text (newlines between logical lines) |
| `getLines(): string[]` | Returns `state.lines` — array of logical lines |
| `getCursor(): { line: number; col: number }` | Returns `{ cursorLine, cursorCol }` — **logical** line/col |
| `setText(text: string): void` | Replaces content; resets cursor (to logical line 0, col 0 — see §3.2) |
| `insertTextAtCursor(text: string): void` | Inserts at cursor, advances cursor past inserted text |
| `getPaddingX(): number` | Render padding (used by label-overlay) |

### 3.2 What `setText()` does to the cursor

`setText()` calls `setTextInternal()` internally. Examining the compiled source:

```js
setText(text) {
    this.historyIndex = -1;
    this.setTextInternal(text);
}
setTextInternal(text) {
    this.state = {
        lines: text.split("\n"),
        cursorLine: 0,
        cursorCol: 0,
    };
    // ... clears undo, autocomplete, etc.
}
```

After `setText()` the cursor is at `{ line: 0, col: 0 }`.

### 3.3 What `moveToLineStart()` / `moveToLineEnd()` actually do

These are the internal handlers for `Ctrl+A` / `Ctrl+E`:

```js
moveToLineStart() {
    this.lastAction = null;
    this.setCursorCol(0);  // col 0 of state.cursorLine (logical)
}
moveToLineEnd() {
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    this.setCursorCol(currentLine.length);  // end of logical line
}
```

**Key finding:** Both operate on `state.cursorLine` — the **logical** line index — and are therefore visual-wrap agnostic.

### 3.4 What Up / Down arrows actually do

From the compiled `handleInput` / `moveCursor` source:

```js
// Up arrow (tui.editor.cursorUp):
if (this.isEditorEmpty()) {
    this.navigateHistory(-1);                 // history nav
} else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
    this.navigateHistory(-1);                 // history nav
} else if (this.isOnFirstVisualLine()) {
    this.moveToLineStart();                   // snap to col 0, NOT moving logical line
} else {
    this.moveCursor(-1, 0);                   // move to visual line above
}

// Down arrow (tui.editor.cursorDown):
if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
    this.navigateHistory(1);                  // history nav
} else if (this.isOnLastVisualLine()) {
    this.moveToLineEnd();                     // snap to line end, NOT moving logical line
} else {
    this.moveCursor(1, 0);                    // move to visual line below
}
```

`moveCursor(±1, 0)` navigates **visual** lines built by `buildVisualLineMap(lastWidth)`. One visual line corresponds to one terminal-width segment of a logical line.

**There is no `setCursor(line, col)` API.** Direct cursor placement is not exposed.

### 3.5 What Right / Left arrows do at logical line boundaries

```js
// Right (moveCursor(0, 1)):
if (cursorCol < currentLine.length) {
    advance one grapheme;
} else if (cursorLine < lines.length - 1) {
    cursorLine++;        // wrap to start of NEXT LOGICAL line
    setCursorCol(0);
} else {
    // at end of last line: no-op (preferredVisualCol side effect only)
}

// Left (moveCursor(0, -1)):
if (cursorCol > 0) {
    retreat one grapheme;
} else if (cursorLine > 0) {
    cursorLine--;        // wrap to end of PREVIOUS LOGICAL line
    setCursorCol(prevLine.length);
}
```

**Right and Left at logical line boundaries cross logical lines correctly, with no visual-line or history effects.**

---

## 4. Root cause of the bug

`navigateTo()` uses `SEQ.up` / `SEQ.down` (Up/Down arrows) to navigate between logical lines. These emit `moveCursor(±1, 0)` which navigates **visual** lines, not logical lines. A logical line that wraps across `k` visual lines requires `k` Up/Down presses to traverse, not one.

Additionally, when the cursor is already on the **first visual line** of the editor (which happens after `getText()` / `setText()` resets to line 0), pressing Up does not move to a higher logical line — instead it calls `moveToLineStart()` (snapping to col 0 in place) or navigates into prompt history.

**Two distinct failure modes:**

1. **Wrapped-line error**: A text with any logical line longer than the terminal width causes off-by-N errors in vertical navigation equal to the number of extra visual lines.
2. **History/boundary trap**: When the cursor is on the topmost visual line, the first Up call snaps col to 0 rather than crossing the logical line boundary. When in history mode, Up navigates to a previous prompt, corrupting state entirely.

---

## 5. Proposed abstraction

### 5.1 Strategy

Replace the Up/Down loops with a **logical-line traversal** that uses only `SEQ.lineEnd` + `SEQ.right` (forward) and `SEQ.lineStart` + `SEQ.left` (backward). These four keys operate on logical positions and cross logical line boundaries correctly.

**Forward across one logical line boundary** (`line → line + 1`):
- `Ctrl+E` → cursor lands at end of logical line `line` (col = `lines[line].length`)
- `Right` → cursor wraps to start of logical line `line + 1` (col 0)

**Backward across one logical line boundary** (`line → line - 1`):
- `Ctrl+A` → cursor lands at start of logical line `line` (col 0)
- `Left` → cursor wraps to end of logical line `line - 1`

After reaching the target logical line, `Ctrl+A` + N×`Right` lands at `targetCol`.

### 5.2 Proposed implementation

```typescript
// ══════════════════════════════════════════════════════════════════════════
// 3d. navigateTo — move cursor to {line, col} (logical line/col semantics)
//
// Semantics:
//   - `line`  is a 0-based index into getLines() (logical lines separated by \n).
//   - `col`   is a 0-based character offset within that logical line.
//   - Both values must be within the bounds of the current text; callers are
//     responsible for clamping (offsetToLineCol already does this).
//
// Implementation:
//   Up/Down arrows navigate VISUAL lines in pi's editor, not logical lines.
//   They also trigger history navigation when on the first/last visual line.
//   This implementation uses only Ctrl+A / Ctrl+E / Left / Right which all
//   operate on logical lines and are immune to visual-wrapping effects.
//
//   Forward (lineDelta > 0): Ctrl+E to end of current line, Right to cross \n.
//   Backward (lineDelta < 0): Ctrl+A to start of current line, Left to cross \n.
//   Then: Ctrl+A to start of target line, N×Right to reach targetCol.
// ══════════════════════════════════════════════════════════════════════════

private navigateTo(targetLine: number, targetCol: number): void {
  const { line } = this.getCursor();
  const lineDelta = targetLine - line;

  if (lineDelta > 0) {
    // Advance by lineDelta logical lines using End+Right per boundary.
    for (let i = 0; i < lineDelta; i++) {
      super.handleInput(SEQ.lineEnd);   // Ctrl+E: jump to end of current logical line
      super.handleInput(SEQ.right);     // Right: cross \n → land at col 0 of next logical line
    }
  } else if (lineDelta < 0) {
    // Retreat by |lineDelta| logical lines using Home+Left per boundary.
    for (let i = 0; i < -lineDelta; i++) {
      super.handleInput(SEQ.lineStart); // Ctrl+A: jump to start of current logical line
      super.handleInput(SEQ.left);      // Left: cross \n → land at end of previous logical line
    }
  }

  // Land at targetCol: go to start of logical line, then advance right.
  super.handleInput(SEQ.lineStart);
  for (let i = 0; i < targetCol; i++) super.handleInput(SEQ.right);

  this.syncSelectionHead();
  this.tui.requestRender();
}
```

No changes are required at any call site — all callers already compute `{line, col}` in logical coordinates using `offsetToLineCol()` or `getCursor()` + arithmetic.

### 5.3 Boundary cases

| Scenario | Behaviour |
|---|---|
| `lineDelta == 0` | No line-crossing loops execute; only `lineStart` + N×`Right`. Correct. |
| `targetCol == 0` | `lineStart` already places cursor at col 0; zero Right presses. Correct. |
| `navigateTo(0, 0)` (`gg`) | lineDelta ≤ 0. Worst case: lineDelta < 0, each iteration does lineStart+Left. After reaching line 0, lineStart+0×Right. If already on line 0: no loops, lineStart, 0 Rights. Correct. |
| `navigateTo(lastLine, lastCol)` (`ge`) | Forward loops: lineEnd+Right for each line. The Right on the last line is a no-op (end of buffer, moveCursor does nothing). Then lineStart + lastCol×Right. **This is still correct** because `lastCol` derived from `lines[lastLine].length` exactly equals the end of the last line. |
| `setText()` then `navigateTo` | `setText` leaves cursor at `{0, 0}`. If targetLine > 0, forward loops apply. Correct. |
| Single-line prompt (no wrapping) | lineDelta uses logical lines, same as before. No change in behaviour. |

---

## 6. Known limitations (if synthetic keys must be kept)

The proposed fix still uses synthetic key sequences internally (`Ctrl+A`, `Ctrl+E`, `Left`, `Right`). The following limitations remain:

### 6.1 O(lineDelta + targetCol) key events

Each call to `navigateTo(L, C)` emits `2 × |lineDelta| + 1 + C` key events through `handleInput`. For typical prompt sizes (< 50 lines, < 200 chars per line) this is imperceptible. For very large multi-line pastes, `actionSelectRegex` or `navigateMatch` iterating through 1000-line text could emit thousands of events. No practical issue currently, but a true `setCursor()` API would eliminate this.

### 6.2 No direct `setCursor()` API exists

`CustomEditor` / `Editor` does not expose a `setCursor(line, col)` method. The only cursor mutation methods accessible from a subclass are:
- `setText(text)` — resets cursor to `{0, 0}`
- `insertTextAtCursor(text)` — advances cursor past inserted text
- `handleInput(data)` — feeds key sequences

A future Pi API addition of `setCursor(line, col)` would allow replacing `navigateTo` with a single direct call:
```typescript
// Hypothetical future API — not currently available:
private navigateTo(targetLine: number, targetCol: number): void {
  this.setCursor(targetLine, targetCol);   // atomic, no key-event side effects
  this.syncSelectionHead();
  this.tui.requestRender();
}
```

### 6.3 Wrapped-line prompt case (resolved by this fix)

With the proposed implementation, wrapped lines no longer affect `navigateTo`. The old Up/Down approach would fail for any logical line exceeding terminal width (e.g., a single-line JSON paste, a long URL). The new End+Right / Home+Left approach is width-independent.

### 6.4 Multi-line prompt history case (resolved by this fix)

With the proposed implementation, `navigateTo` never emits Up or Down, so history navigation cannot be triggered. The old implementation could corrupt state when called on the first visual line of the editor.

### 6.5 `Right` at end of last line is a no-op

`moveCursor(0, 1)` at `{lastLine, lastCol}` does nothing (there is no next line). The forward loop calls `lineEnd + Right` per line — the final `Right` call after `lineEnd` on the last line is a no-op. This is only reached when `lineDelta > 0` and the target IS the last line, meaning the caller asked to land on the last line from somewhere above. After the no-op Right, `lineStart + targetCol×Right` still places the cursor correctly on the last line. **No bug.**

### 6.6 Left at start of first line is a no-op

`moveCursor(0, -1)` at `{0, 0}` does nothing. The backward loop calls `lineStart + Left` per line — if somehow called when already on line 0, `Left` does nothing. This is guarded by `lineDelta < 0` only executing when `targetLine < currentLine`, so `currentLine ≥ 1` is always true. **No bug.**

---

## 7. Acceptance criteria checklist

- [ ] **Single navigation abstraction**: `navigateTo(line, col)` is the sole cursor-placement entry point; all 15 call sites are unchanged.
- [ ] **Logical-line semantics documented**: JSDoc comment in the implementation explicitly states `line` is a 0-based index into `getLines()` and `col` is a 0-based character offset within that logical line.
- [ ] **No Up/Down for logical line targeting**: The implementation uses `SEQ.lineEnd + SEQ.right` (forward) and `SEQ.lineStart + SEQ.left` (backward) — no `SEQ.up` or `SEQ.down` in the new body.
- [ ] **No direct `setCursor` API exists — fallback isolated**: The synthetic-key fallback is entirely contained in `navigateTo()`; callers have no awareness of the implementation.
- [ ] **Fallback limitations documented**: Known limitations §6.1–§6.6 call out wrapped-line safety (resolved), history safety (resolved), O(n) cost, and missing `setCursor` API.
- [ ] **Wrapped-line case addressed**: The End+Right / Home+Left approach is width-independent; wrapping cannot cause off-by-N line errors.
- [ ] **Multi-line prompt (history) case addressed**: No Up/Down emitted by `navigateTo`; history cannot be triggered.
- [ ] **All affected features covered**: Search (`n`/`N`/`*`), `gg`/`ge`/`gw`, `i`/`a`/`o`/`O`, `w`/`b`/`e`, `d`/`c`, `>`/`<`, `x`, `s` — all route through the single `navigateTo()`.
