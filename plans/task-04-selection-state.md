# Task 04 — Selection State

## Problem Summary

`editor.ts` tracks selection with a bare `selectionAnchor: { line: number; col: number } | null`
field. The cursor position (`getCursor()`) acts as the implicit "head." Every command that
needs selection bounds re-derives them independently — calling `selectionRange()`, reading
`.line`/`.col` fields directly, or doing ad-hoc offset arithmetic. There is no single type
that encapsulates a selection, no single place to normalise anchor/head ordering, and the
`i`/`a` mode-entry commands ignore the active selection entirely.

---

## 1. Audit — Every Place `selectionAnchor` Is Read or Selection Bounds Are Computed

### 1.1 Field declaration

```
editor.ts:79
  private selectionAnchor: { line: number; col: number } | null = null;
```

Raw struct field. No encapsulation, no invariant enforcement.

---

### 1.2 `enterInsert()` (line ~90)

```ts
this.selectionAnchor = null;
```

Clears the anchor unconditionally. Does **not** consult the current selection bounds before
switching mode. In Helix, `i` in select mode should collapse the cursor to the selection
start; `a` should collapse to just after the selection end. Neither happens.

---

### 1.3 `enterNormal()` (line ~98)

```ts
this.selectionAnchor = null;
```

Clears unconditionally. Correct for a mode transition, but the clearing is done by directly
mutating the raw field rather than through any helper.

---

### 1.4 `enterSelect()` (line ~107)

```ts
this.selectionAnchor = this.getCursor();
```

Writes the raw struct directly. No helper, no type.

---

### 1.5 `getSelectionCharCount()` (line ~117)

```ts
const { start, end } = selectionRange(lines, this.selectionAnchor, this.getCursor());
return end - start + 1;
```

Calls `selectionRange` but the caller must remember the `+1` for inclusive count. The check
`if (!this.selectionAnchor) return 0` at the top is a guard, not encapsulation.

---

### 1.6 `render()` — selection highlight (line ~134)

```ts
if (this.mode === "select" && this.selectionAnchor && !this.labelMode) {
  const { start, end } = selectionRange(logicalLines, this.selectionAnchor, this.getCursor());
  ...
}
```

Third independent call to `selectionRange`. The guard `this.selectionAnchor &&` is repeated
ad hoc.

---

### 1.7 `getEffectiveRange()` (line ~258)

```ts
private getEffectiveRange(): { start: number; end: number } {
  const lines = this.getLines();
  const cursor = this.getCursor();
  if (this.selectionAnchor) {
    return selectionRange(lines, this.selectionAnchor, cursor);
  }
  const offset = lineColToOffset(lines, cursor.line, cursor.col);
  return { start: offset, end: offset };
}
```

The fallback `{ start: offset, end: offset }` (no selection) is indistinguishable from a
one-character selection where anchor === head. `actionDelete` later special-cases
`start === end` to mean "no real selection," conflating these two situations.

---

### 1.8 `actionDelete()` (line ~271)

```ts
const { start, end } = this.getEffectiveRange();
if (start === end) {
  super.handleInput(SEQ.deleteForward);   // delete char under cursor
  ...
  return;
}
const { newText, cursorOffset } = deleteRange(text, start, end);
```

Relies on `start === end` as a sentinel for "no selection." This conflates the empty-range
sentinel from `getEffectiveRange()` with a genuine one-character selection at anchor === head
(e.g., user pressed `v` then immediately `d`).

---

### 1.9 `actionChange()` (line ~284)

```ts
private actionChange(): void {
  this.actionDelete();
  this.enterInsert();
  ...
}
```

Inherits all of `actionDelete`'s selection handling. `enterInsert()` is then called, which
clears the anchor — but at this point the deletion has already happened, so the anchor was
already consumed. Correct outcome but fragile chain.

---

### 1.10 `actionSelectLine()` (line ~290)

```ts
if (this.mode === "select" && this.selectionAnchor) {
  const { lastLine } = linesInRange(
    this.getText(),
    lineColToOffset(lines, this.selectionAnchor.line, this.selectionAnchor.col),
    lineColToOffset(lines, cursor.line, cursor.col),
  );
```

Reads `this.selectionAnchor.line` and `this.selectionAnchor.col` **directly** — the only
command site that does not go through `selectionRange`. This means the anchor is used raw,
with no normalisation: if the user selected upward (head above anchor), the `linesInRange`
call receives the anchor as `start` even though it is the *later* offset. `linesInRange`
itself calls `offsetToLineCol` on both endpoints and does not require ordering, so the
result happens to be correct — but only because of that coincidence, not by design.

```ts
} else {
  const lineStart = 0;
  const lineEnd = (lines[cursor.line] ?? "").length;
  this.selectionAnchor = { line: cursor.line, col: lineStart };
  this.mode = "select";
  this.navigateTo(cursor.line, lineEnd);
}
```

Sets the anchor directly with an inline struct literal.

---

### 1.11 `actionIndent()` (line ~311)

```ts
if (this.selectionAnchor) {
  const range = selectionRange(lines, this.selectionAnchor, cursor);
  const lr = linesInRange(text, range.start, range.end);
  firstLine = lr.firstLine;
  lastLine = lr.lastLine;
}
```

Fifth call to `selectionRange`. After the text manipulation the cursor column is restored:

```ts
const indentDelta = indent ? 2 : -Math.min(2, lines[cursor.line]?.match(/^ */)?.[0].length ?? 0);
const newCursorCol = Math.max(0, cursor.col + indentDelta);
this.navigateTo(newCursorLine, newCursorCol);
```

`cursor.line` is the cursor position **before** the indent, and `lines[cursor.line]` is also
the **original** line. The cursor may be at the bottom of the selection (if user selected
downward), in which case the restoration is at the head of the selection — fine — but the
logic relies on ambient `cursor` rather than an explicit "where does the head live" concept
from the selection.

---

### 1.12 `actionSelectRegex()` (line ~334)

```ts
if (this.selectionAnchor) {
  const range = selectionRange(lines, this.selectionAnchor, cursor);
  searchStart = range.start;
  searchEnd = range.end + 1;   // ← ad-hoc exclusive conversion
}
```

Sixth call to `selectionRange`. The `+ 1` to make the end exclusive for `text.slice` is
ad-hoc. After finding matches:

```ts
this.selectionAnchor = target;
this.mode = "select";
```

Sets `selectionAnchor` directly, then navigates the head to the match end.

---

### 1.13 `actionSearchSelection()` (line ~358)

```ts
if (this.selectionAnchor) {
  const range = selectionRange(lines, this.selectionAnchor, cursor);
  selectedText = extractSelection(text, range.start, range.end);
} else {
  // ad-hoc word-under-cursor with while loops
  while (start > 0 && /\w/.test(text[start - 1]!)) start--;
  while (end < text.length - 1 && /\w/.test(text[end + 1]!)) end++;
  selectedText = text.slice(start, end + 1);
}
```

Seventh call to `selectionRange`. The "no selection" branch uses inline while-loop word
expansion rather than `prevWordStart`/`nextWordEnd` from `buffer.ts`.

---

### 1.14 `navigateMatch()` (line ~387)

```ts
this.selectionAnchor = target;   // target = offsetToLineCol(text, match.start)
this.mode = "select";
const endTarget = offsetToLineCol(text, match.end);
this.navigateTo(endTarget.line, endTarget.col);
```

Sets `selectionAnchor` directly. No helper or factory.

---

### 1.15 `i` command handler (line ~226)

```ts
if (data === "i") { this.enterInsert(); this.tui.requestRender(); return; }
```

`enterInsert()` clears the anchor, cursor stays wherever it currently is. In Helix, `i` in
visual/select mode collapses the cursor to the *start* (lower bound) of the selection. This
is not implemented.

---

### 1.16 `a` command handler (line ~228)

```ts
if (data === "a") {
  this.enterInsert();
  super.handleInput(SEQ.right);
  ...
}
```

`enterInsert()` clears the anchor, then the cursor moves one position right. In Helix, `a`
in visual/select mode collapses the cursor to just *after* the *end* (upper bound) of the
selection, regardless of which direction the selection was made. The current code moves one
right from wherever the cursor (head) is — correct only when the head is already at the
end of the selection (i.e., the user selected forward). If the user selected backward (head
is above anchor), `a` would land one right of the head, which is *inside* the selection.

---

## 2. Proposed `SelectionState` Type and Helper Functions

### Location

Add a new file `extensions/helix-mode/selection.ts`. It has no Pi or TUI dependencies —
only imports from `buffer.ts`. This keeps it fully unit-testable in isolation.

`buffer.ts` retains `selectionRange`, `extractSelection`, `deleteRange`, and `linesInRange`
unchanged — they are low-level pure primitives. `selection.ts` builds the higher-level
`SelectionState` abstraction on top of them.

---

### 2.1 `SelectionState` type

```ts
/**
 * A selection is the pair (anchor, head) where:
 *   - anchor is the fixed end set when selection begins
 *   - head   is the moving end (current cursor position)
 *
 * Either end can be the textually earlier position.
 * All helpers normalise the pair before computing offsets.
 */
export interface SelectionState {
  anchor: { line: number; col: number };
  head:   { line: number; col: number };
}
```

---

### 2.2 Factory helpers

```ts
/**
 * Create a zero-width (collapsed) selection at a single cursor position.
 * anchor === head. Used when entering select mode.
 */
export function selectionFromCursor(
  cursor: { line: number; col: number },
): SelectionState

/**
 * Create a selection from an explicit anchor and head.
 * Either end may be textually earlier.
 */
export function makeSelection(
  anchor: { line: number; col: number },
  head:   { line: number; col: number },
): SelectionState
```

---

### 2.3 Normalisation helpers

```ts
/**
 * Return {start, end} as inclusive linear offsets with start <= end.
 * Equivalent to the current selectionRange() call pattern:
 *   selectionRange(lines, sel.anchor, sel.head)
 * but derived from a typed SelectionState rather than two raw structs.
 */
export function normalizeRange(
  lines: string[],
  sel: SelectionState,
): { start: number; end: number }

/**
 * Return the textually earlier of anchor/head as {line, col}.
 * This is where the cursor lands on `i` (insert before).
 */
export function selectionStart(
  lines: string[],
  sel: SelectionState,
): { line: number; col: number }

/**
 * Return the textually later of anchor/head as {line, col}.
 * This is the last selected character for `a` (append after).
 */
export function selectionEnd(
  lines: string[],
  sel: SelectionState,
): { line: number; col: number }
```

---

### 2.4 Query helpers

```ts
/**
 * True when anchor and head map to different offsets (non-zero-width selection).
 * Used to distinguish "user made a selection" from "entered select mode but
 * hasn't moved yet" — the case that currently conflates with start === end in
 * getEffectiveRange().
 */
export function isNonEmpty(
  lines: string[],
  sel: SelectionState,
): boolean

/**
 * Number of characters covered by the selection (inclusive, minimum 1).
 * Replaces getSelectionCharCount()'s inline `end - start + 1`.
 */
export function selectionCharCount(
  lines: string[],
  sel: SelectionState,
): number

/**
 * Line range (inclusive) covered by the selection.
 * Replaces the pattern:
 *   linesInRange(text, range.start, range.end)
 * where range came from selectionRange().
 */
export function selectionLineRange(
  text: string,
  lines: string[],
  sel: SelectionState,
): { firstLine: number; lastLine: number }

/**
 * Return the slice of `text` covered by the selection (inclusive).
 * Replaces extractSelection(text, range.start, range.end) call sites.
 */
export function selectionText(
  text: string,
  lines: string[],
  sel: SelectionState,
): string
```

---

### 2.5 Full module shape (summary)

```ts
// extensions/helix-mode/selection.ts

export interface SelectionState { ... }

export function selectionFromCursor(cursor): SelectionState
export function makeSelection(anchor, head): SelectionState

export function normalizeRange(lines, sel): { start: number; end: number }
export function selectionStart(lines, sel): { line: number; col: number }
export function selectionEnd(lines, sel): { line: number; col: number }

export function isNonEmpty(lines, sel): boolean
export function selectionCharCount(lines, sel): number
export function selectionLineRange(text, lines, sel): { firstLine: number; lastLine: number }
export function selectionText(text, lines, sel): string
```

All functions are pure: `(data) => result`. No class, no side effects.

---

## 3. Command-Site Migration

### 3.1 Field rename in `HelixEditor`

```diff
- private selectionAnchor: { line: number; col: number } | null = null;
+ private selection: SelectionState | null = null;
```

Every reference to `this.selectionAnchor` becomes `this.selection`. The conceptual change is
that the new field carries both anchor and head, so the implicit "head = getCursor()" idiom
is formalised — callers either read `sel.head` or use a helper.

**Note:** in normal mode, `this.selection` is always `null`. In select mode, `sel.head` is
kept in sync with the cursor: every movement call (via `moveOrExtend` / `navigateTo`) should
update `sel.head` to `this.getCursor()` after the move. See §3.2.

---

### 3.2 `moveOrExtend` — keep head in sync

Currently, select mode extends the selection simply because `selectionAnchor` is frozen while
the cursor moves. With the new type, `sel.head` must be updated after each move. Add a
`syncSelectionHead()` private helper:

```ts
private syncSelectionHead(): void {
  if (this.selection) {
    this.selection = makeSelection(this.selection.anchor, this.getCursor());
  }
}
```

Call it at the end of `moveOrExtend`, `moveWordNext`, `moveWordPrev`, `moveWordEnd`, and
`navigateTo`. This makes the invariant explicit: `sel.head` always equals the cursor when
a selection is active.

---

### 3.3 `enterInsert()` — no change to signature

The method continues to clear selection:

```ts
private enterInsert(): void {
  this.mode = "insert";
  this.selection = null;
  ...
}
```

Cursor placement before calling `enterInsert()` is the responsibility of the caller
(see §3.4 for `i` and `a`).

---

### 3.4 `i` command — insert before selection

```diff
- if (data === "i") { this.enterInsert(); this.tui.requestRender(); return; }
+ if (data === "i") {
+   if (this.selection) {
+     const start = selectionStart(this.getLines(), this.selection);
+     this.navigateTo(start.line, start.col);
+   }
+   this.enterInsert();
+   this.tui.requestRender();
+   return;
+ }
```

`navigateTo` is called *before* `enterInsert()` so the cursor lands at the selection start.
`enterInsert()` then clears `this.selection`. In the common case (no active selection, mode
is normal), `this.selection` is null and behavior is unchanged.

---

### 3.5 `a` command — append after selection

```diff
- if (data === "a") {
-   this.enterInsert();
-   super.handleInput(SEQ.right);
-   ...
- }
+ if (data === "a") {
+   if (this.selection) {
+     const end = selectionEnd(this.getLines(), this.selection);
+     // Place cursor one position past the last selected character.
+     // navigateTo then enterInsert clears the selection.
+     const text = this.getText();
+     const endOffset = lineColToOffset(this.getLines(), end.line, end.col);
+     const afterEnd = offsetToLineCol(text, Math.min(endOffset + 1, text.length));
+     this.navigateTo(afterEnd.line, afterEnd.col);
+   } else {
+     super.handleInput(SEQ.right);
+   }
+   this.enterInsert();
+   this.tui.requestRender();
+   return;
+ }
```

When there is an active selection, the cursor is placed at `selectionEnd + 1` (clamped to
text length) — independent of whether the selection was made forward or backward. When there
is no active selection, the original "move one right" behavior is preserved.

---

### 3.6 `enterSelect()`

```diff
- this.selectionAnchor = this.getCursor();
+ this.selection = selectionFromCursor(this.getCursor());
```

---

### 3.7 `getSelectionCharCount()`

```diff
- const { start, end } = selectionRange(lines, this.selectionAnchor, this.getCursor());
- return end - start + 1;
+ return selectionCharCount(lines, this.selection!);
```

The `!` is safe because this method is only called when `this.selection` is non-null (from
`getModeLabel()` which is only called in select mode).

---

### 3.8 `render()` — selection highlight

```diff
- if (this.mode === "select" && this.selectionAnchor && !this.labelMode) {
-   const { start, end } = selectionRange(logicalLines, this.selectionAnchor, this.getCursor());
+ if (this.mode === "select" && this.selection && !this.labelMode) {
+   const { start, end } = normalizeRange(logicalLines, this.selection);
```

---

### 3.9 `getEffectiveRange()` — fix the sentinel problem

Current: `{ start: offset, end: offset }` for no-selection is indistinguishable from a
single-char selection. New approach: return `null` for no selection.

```ts
private getEffectiveRange(): { start: number; end: number } | null {
  if (!this.selection) return null;
  const lines = this.getLines();
  return normalizeRange(lines, this.selection);
}
```

---

### 3.10 `actionDelete()` — use explicit null check

```diff
- const { start, end } = this.getEffectiveRange();
- if (start === end) {
-   super.handleInput(SEQ.deleteForward);
-   ...
-   return;
- }
+ const range = this.getEffectiveRange();
+ if (!range || !isNonEmpty(this.getLines(), this.selection!)) {
+   // No selection or zero-width selection: delete char under cursor
+   super.handleInput(SEQ.deleteForward);
+   this.selection = null;
+   this.mode = "normal";
+   this.tui.requestRender();
+   return;
+ }
+ const { start, end } = range;
```

This makes the two cases explicit:
- `range === null`: no selection at all (normal mode `d`)
- `range` present but `!isNonEmpty(...)`: entered select mode (`v`) but cursor hasn't moved

Both cases delete a single character. The selection is cleared in both paths.

---

### 3.11 `actionSelectLine()` — use `selectionLineRange` and `selectionEnd`

```diff
- if (this.mode === "select" && this.selectionAnchor) {
-   const { lastLine } = linesInRange(
-     this.getText(),
-     lineColToOffset(lines, this.selectionAnchor.line, this.selectionAnchor.col),
-     lineColToOffset(lines, cursor.line, cursor.col),
-   );
+ if (this.mode === "select" && this.selection) {
+   const { lastLine } = selectionLineRange(this.getText(), lines, this.selection);
```

```diff
- } else {
-   const lineStart = 0;
-   const lineEnd = (lines[cursor.line] ?? "").length;
-   this.selectionAnchor = { line: cursor.line, col: lineStart };
-   this.mode = "select";
-   this.navigateTo(cursor.line, lineEnd);
- }
+ } else {
+   const lineEnd = (lines[cursor.line] ?? "").length;
+   this.selection = makeSelection(
+     { line: cursor.line, col: 0 },
+     { line: cursor.line, col: lineEnd },
+   );
+   this.mode = "select";
+   this.navigateTo(cursor.line, lineEnd);
+   // syncSelectionHead() will be called inside navigateTo
+ }
```

---

### 3.12 `actionIndent()` — use `selectionLineRange`

```diff
- if (this.selectionAnchor) {
-   const range = selectionRange(lines, this.selectionAnchor, cursor);
-   const lr = linesInRange(text, range.start, range.end);
-   firstLine = lr.firstLine;
-   lastLine = lr.lastLine;
- }
+ if (this.selection) {
+   const lr = selectionLineRange(text, lines, this.selection);
+   firstLine = lr.firstLine;
+   lastLine = lr.lastLine;
+ }
```

---

### 3.13 `actionSelectRegex()` — use `normalizeRange` and `makeSelection`

```diff
- if (this.selectionAnchor) {
-   const range = selectionRange(lines, this.selectionAnchor, cursor);
-   searchStart = range.start;
-   searchEnd = range.end + 1;
- }
+ if (this.selection) {
+   const { start, end } = normalizeRange(lines, this.selection);
+   searchStart = start;
+   searchEnd = end + 1;   // exclusive for text.slice
+ }
```

```diff
- this.selectionAnchor = target;
- this.mode = "select";
+ this.selection = makeSelection(target, endTarget);
+ this.mode = "select";
```

Where `target = offsetToLineCol(text, first.start)` and `endTarget = offsetToLineCol(text, first.end)`.

---

### 3.14 `actionSearchSelection()` — use `selectionText` and `normalizeRange`

```diff
- if (this.selectionAnchor) {
-   const range = selectionRange(lines, this.selectionAnchor, cursor);
-   selectedText = extractSelection(text, range.start, range.end);
- } else {
-   let start = offset;
-   let end = offset;
-   while (start > 0 && /\w/.test(text[start - 1]!)) start--;
-   while (end < text.length - 1 && /\w/.test(text[end + 1]!)) end++;
-   selectedText = text.slice(start, end + 1);
-   if (!selectedText) return;
- }
+ if (this.selection) {
+   selectedText = selectionText(text, lines, this.selection);
+ } else {
+   // Word under cursor: use prevWordStart / nextWordEnd from buffer.ts
+   const wordStart = prevWordStart(text, offset + 1);  // +1 so current char counts
+   const wordEnd   = nextWordEnd(text, offset - 1);    // -1 so current char counts
+   selectedText = text.slice(wordStart, wordEnd + 1);
+   if (!selectedText) return;
+ }
```

The "word under cursor" fallback is also improved to use the existing `prevWordStart` /
`nextWordEnd` functions from `buffer.ts` instead of inline while loops.

---

### 3.15 `navigateMatch()` — use `makeSelection`

```diff
- this.selectionAnchor = target;
- this.mode = "select";
- const endTarget = offsetToLineCol(text, match.end);
- this.navigateTo(endTarget.line, endTarget.col);
+ const endTarget = offsetToLineCol(text, match.end);
+ this.selection = makeSelection(target, endTarget);
+ this.mode = "select";
+ this.navigateTo(endTarget.line, endTarget.col);
```

---

### 3.16 `enterNormal()` / `handleNormalInput` escape-in-select path

```diff
- this.selectionAnchor = null;
+ this.selection = null;
```

(Two occurrences: `enterNormal()` and the escape-in-select branch of `handleNormalInput`.)

---

## 4. Files Touched

| File | Change |
|---|---|
| `extensions/helix-mode/selection.ts` | **New file.** `SelectionState` type + all helpers |
| `extensions/helix-mode/editor.ts` | Replace `selectionAnchor` field; update all command sites; add `syncSelectionHead()`; fix `i` and `a` |
| `extensions/helix-mode/buffer.ts` | No functional changes. Existing primitives (`selectionRange`, `linesInRange`, `extractSelection`, `deleteRange`) remain; `selection.ts` imports them |

---

## 5. Acceptance Criteria Checklist

### Type / module

- [ ] `SelectionState` interface is exported from `selection.ts`
- [ ] All helpers in §2 are exported from `selection.ts` with the exact signatures listed
- [ ] `selection.ts` imports only from `buffer.ts` — no Pi/TUI dependencies
- [ ] `buffer.ts` is unchanged (no behavioural changes)

### Field migration

- [ ] `HelixEditor.selectionAnchor` is removed; replaced by `selection: SelectionState | null`
- [ ] No remaining references to `selectionAnchor` in `editor.ts`
- [ ] `syncSelectionHead()` exists and is called from `moveOrExtend`, `moveWordNext`, `moveWordPrev`, `moveWordEnd`, and `navigateTo`

### `i` and `a` selection behavior

- [ ] `i` in select mode with a non-empty selection places the cursor at `selectionStart` before entering insert
- [ ] `i` in normal mode (no selection) is unchanged — cursor stays, insert mode is entered
- [ ] `a` in select mode with a non-empty selection places the cursor one position after `selectionEnd` before entering insert
- [ ] `a` in select mode with a backward selection (head above anchor) still places cursor after the *textual* end, not after the head
- [ ] `a` in normal mode (no selection) is unchanged — cursor moves one right

### Command-site migrations (no ad-hoc `selectionRange` calls remain)

- [ ] `getSelectionCharCount` uses `selectionCharCount(lines, this.selection!)`
- [ ] `render()` uses `normalizeRange(logicalLines, this.selection)`
- [ ] `getEffectiveRange()` returns `{ start, end } | null` (null = no selection)
- [ ] `actionDelete()` checks `!range || !isNonEmpty(...)` instead of `start === end`
- [ ] `actionSelectLine()` uses `selectionLineRange` (no direct `.line`/`.col` field reads on anchor)
- [ ] `actionSelectLine()` uses `makeSelection(...)` to create new selections
- [ ] `actionIndent()` uses `selectionLineRange`
- [ ] `actionSelectRegex()` uses `normalizeRange` and `makeSelection`
- [ ] `actionSearchSelection()` uses `selectionText` and `prevWordStart`/`nextWordEnd` for fallback
- [ ] `navigateMatch()` uses `makeSelection`

### Pure-function unit testability

- [ ] `normalizeRange` can be tested with only `{ anchor, head }` structs and a `string[]` — no editor or TUI required
- [ ] `selectionStart` / `selectionEnd` can be tested the same way
- [ ] `isNonEmpty` can be tested the same way
- [ ] `selectionCharCount` can be tested the same way
- [ ] `selectionLineRange` can be tested with `text: string` + `lines: string[]` + `SelectionState`
- [ ] `selectionText` can be tested with `text: string` + `lines: string[]` + `SelectionState`
- [ ] At least one test file (`selection.test.ts`) is created alongside the module covering:
  - Forward selection (anchor before head)
  - Backward selection (head before anchor)
  - Zero-width selection (anchor === head)
  - Multi-line selection
  - `i`/`a` cursor placement for both forward and backward selections
