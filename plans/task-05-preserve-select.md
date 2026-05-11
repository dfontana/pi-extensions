# Task 05 — Preserve Selection Across Select→Normal Escape

## Problem Summary

Pressing `Escape` from Select mode currently clears `this.selection` before
returning to Normal mode. This violates Helix's selection-first model: a
retained selection should remain available for subsequent operations (`d`, `c`,
`>`, `<`, `s`, `*`) after leaving Select mode. A second `Escape` from Normal
mode (with a retained selection) should then clear it and return to "clean"
Normal.

---

## Exact Line References — Current Escape-in-Select Handling

### `handleNormalInput()` — lines 294–302 of `editor.ts`

```typescript
// editor.ts  line 294
if (matchesKey(data, "escape")) {
  if (this.mode === "select") {
    this.mode = "normal";
    this.selection = null;      // ← line 297: BUG — clears the selection
    this.tui.requestRender();
    return;
  }
  super.handleInput(data);      // ← Normal Escape forwarded to super
  return;
}
```

The comment on line 292 (`"return to normal without clearing selection position"`)
already documents the intended behaviour; the implementation contradicts the
comment by setting `this.selection = null` on line 297.

### `enterNormal()` — lines 126–134 of `editor.ts`

```typescript
// editor.ts  line 126
private enterNormal(): void {
  this.mode = "normal";
  this.selection = null;        // ← line 128: always clears
  this.pendingPrefix = null;
  this.pendingReplace = false;
  this.labelMode = false;
  this.labelMap = new Map();
  this.pendingInput = null;
}
```

`enterNormal()` is **not** called from the Select Escape path — the escape
handler manipulates `this.mode` and `this.selection` directly. `enterNormal()`
is called only from the Insert Escape path (line 244). Because there is never
an active selection when leaving Insert mode, its `this.selection = null` is
harmless and should be left unchanged.

### `render()` — line 169 of `editor.ts`

```typescript
// editor.ts  line 169
if (this.mode === "select" && this.selection && !this.labelMode) {
```

The selection highlight is mode-gated to `"select"` only. After the fix, a
retained selection in Normal mode will be invisible unless this condition is
widened.

### `getModeLabel()` — lines 143–149 of `editor.ts`

```typescript
// editor.ts  line 143
private getModeLabel(): string {
  if (this.mode === "insert") return " INSERT ";
  if (this.mode === "select") {
    const charCount = this.getSelectionCharCount();
    return ` SELECT (${charCount}) `;
  }
  return " NORMAL ";            // ← no char count shown in Normal
}
```

Normal mode always renders `" NORMAL "` with no indication of a retained
selection, leaving the user unable to distinguish "clean Normal" from "Normal
with retained selection".

---

## SelectionState — Relevant Type (`selection.ts`)

```typescript
export interface SelectionState {
  anchor: { line: number; col: number };
  head:   { line: number; col: number };
}
```

`this.selection: SelectionState | null` holds the anchor/head pair. Setting it
to `null` is the only way to discard a selection; setting it to a
`SelectionState` value keeps it active regardless of `this.mode`.

`getEffectiveRange()` (editor.ts line 549) already returns
`normalizeRange(lines, this.selection)` whenever `this.selection !== null`,
meaning `d`, `c`, `>`, `<`, `s`, and `*` will automatically consume a retained
Normal-mode selection without any change to those action methods.

---

## Proposed Diff

### 1. `handleNormalInput()` — fix the Escape handler (lines 294–302)

**Before:**
```typescript
if (matchesKey(data, "escape")) {
  if (this.mode === "select") {
    this.mode = "normal";
    this.selection = null;
    this.tui.requestRender();
    return;
  }
  super.handleInput(data);
  return;
}
```

**After:**
```typescript
if (matchesKey(data, "escape")) {
  if (this.mode === "select") {
    // Return to Normal but keep this.selection so the next operation
    // (d, c, >, <, s, *) can still consume it.  A second Escape from
    // Normal will clear it (see branch below).
    this.mode = "normal";
    this.pendingPrefix = null;
    this.tui.requestRender();
    return;
  }
  if (this.mode === "normal" && this.selection !== null) {
    // Second Escape: discard the retained selection and stay in Normal.
    this.selection = null;
    this.tui.requestRender();
    return;
  }
  // Clean Normal (no retained selection): forward to super so the app can
  // handle Escape (e.g. abort agent run).
  super.handleInput(data);
  return;
}
```

Key points:
- Removed `this.selection = null` from the select branch.
- Added `this.pendingPrefix = null` in the select branch (mirrors what
  `enterNormal()` does; ensures no stale `g`-prefix survives the transition).
- New `normal && selection !== null` branch handles second Escape cleanly
  without a `requestRender`-less fallthrough to super.

### 2. `render()` — extend highlight to Normal mode with retained selection (line 169)

**Before:**
```typescript
if (this.mode === "select" && this.selection && !this.labelMode) {
```

**After:**
```typescript
if ((this.mode === "select" || this.mode === "normal") && this.selection && !this.labelMode) {
```

This keeps the selection highlight visible after returning to Normal, giving
the user continuous visual feedback that a selection is retained and ready to
use.

### 3. `getModeLabel()` — surface retained selection in Normal label (lines 143–149)

**Before:**
```typescript
private getModeLabel(): string {
  if (this.mode === "insert") return " INSERT ";
  if (this.mode === "select") {
    const charCount = this.getSelectionCharCount();
    return ` SELECT (${charCount}) `;
  }
  return " NORMAL ";
}
```

**After:**
```typescript
private getModeLabel(): string {
  if (this.mode === "insert") return " INSERT ";
  if (this.mode === "select") {
    const charCount = this.getSelectionCharCount();
    return ` SELECT (${charCount}) `;
  }
  if (this.selection !== null) {
    const charCount = this.getSelectionCharCount();
    return ` NORMAL (${charCount}) `;
  }
  return " NORMAL ";
}
```

The ANSI colouring in `getModeLabelAnsi()` already keys on `this.mode`, so the
`NORMAL (N)` label will render in cyan bold — consistent with ordinary Normal
mode, distinct from the yellow bold SELECT label.

### 4. No changes required for

| Site | Why unchanged |
|---|---|
| `enterNormal()` (line 126) | Not called from Select Escape; the `this.selection = null` inside it only fires from Insert Escape, where there is never a live selection. |
| `getEffectiveRange()` (line 549) | Already returns the selection whenever `this.selection !== null`, regardless of mode. |
| `actionDelete()`, `actionChange()`, `actionIndent()`, `actionSelectRegex()`, `actionSearchSelection()` | All consume `getEffectiveRange()` / `this.selection` directly; they already set `this.selection = null` and `this.mode = "normal"` after consuming, which is the correct cleanup. |
| `getSelectionCharCount()` (line 152) | Returns 0 when `this.selection` is null; correctly non-zero for any live selection. |

---

## Behaviour After Fix

### render() in Normal mode with retained selection

- `this.mode === "normal"`, `this.selection !== null`
- Highlight condition (widened): fires → `computeSelectionSpans` + `applySelectionHighlight` run as in Select mode.
- Mode label: `" NORMAL (N) "` in cyan bold via `getModeLabelAnsi`.
- No label-mode interference (guarded by `!this.labelMode`).

### getModeLabel() states

| State | Label |
|---|---|
| Insert | ` INSERT ` (dim) |
| Select | ` SELECT (N) ` (yellow bold) |
| Normal, retained selection | ` NORMAL (N) ` (cyan bold) |
| Normal, clean | ` NORMAL ` (cyan bold) |

### getSelectionCharCount() in all modes

`getSelectionCharCount()` delegates to `selectionCharCount(lines, this.selection)`. It is only called from `getModeLabel()`, so the Normal-with-selection path now calls it too. Because `this.selection !== null` is a precondition for that branch, the existing null guard (`if (!this.selection) return 0`) is never hit; no change needed.

---

## Acceptance Criteria Checklist

- [ ] **Escape from Select → Normal keeps selection**: `this.selection` is
      non-null after the transition; mode is `"normal"`.

- [ ] **Highlight visible in Normal with retained selection**: `render()`
      applies `applySelectionHighlight` when `this.mode === "normal"` and
      `this.selection !== null`.

- [ ] **Mode label shows char count**: `getModeLabel()` returns
      `" NORMAL (N) "` (not `" NORMAL "`) when selection is retained; the
      count matches the Select-mode count that was showing before Escape.

- [ ] **Second Escape clears selection**: Pressing Escape again from Normal
      (with retained selection) sets `this.selection = null`, label reverts to
      `" NORMAL "`, highlight disappears.

- [ ] **Third Escape passes to super**: After selection is cleared, Escape in
      Normal falls through to `super.handleInput(data)` (existing behaviour for
      abort/close).

- [ ] **`d` from Normal with retained selection deletes selection**: `actionDelete()`
      resolves `getEffectiveRange()` → non-null → deletes the range and clears
      `this.selection`.

- [ ] **`c` from Normal with retained selection changes selection**: Same as
      `d` + enters Insert.

- [ ] **`>` / `<` from Normal with retained selection indents selection lines**:
      `actionIndent()` uses `selectionLineRange` → first/lastLine from retained
      selection.

- [ ] **`s` from Normal with retained selection searches within it**:
      `actionSelectRegex()` slices `searchStart..searchEnd` from retained
      selection.

- [ ] **`*` from Normal with retained selection searches for selection text**:
      `actionSearchSelection()` uses `selectionText()` from retained selection.

- [ ] **`v` re-enters Select from Normal (with or without retained selection)**:
      `enterSelect()` always resets `this.selection` to a fresh
      `selectionFromCursor`, so any retained selection is cleanly replaced.

- [ ] **Insert Escape (Normal → Insert → Normal) does not retain phantom selection**:
      `enterNormal()` still sets `this.selection = null`; Insert mode never
      sets `this.selection`, so this path is unaffected.

- [ ] **No regressions in label-jump mode (`gw`)**: `!this.labelMode` guard in
      `render()` is unchanged; retained selection highlight is suppressed during
      label overlay as before.
