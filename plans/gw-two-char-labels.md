# Plan: `gw` — Two-character labels + cursor-proximity ordering

## Context

`gw` is helix-mode's jump-to-word shortcut. It currently:
- Supports only 52 jump targets (single-char labels `a-z`, `A-Z`)
- Assigns labels top-to-bottom from the buffer start, so when the cursor is
  near the bottom of the editor the closest words often have no labels left

The two improvements requested:
1. **More labels** — support 2-character labels to unlock 676+ extra jump targets
2. **Cursor-proximity ordering** — words nearer the cursor get labels first, so
   a jump is always available close by

---

## Approach

### Label alphabet

All labels are two-character lowercase pairs: `aa`, `ab`, … `zz` — **676** jump targets total. No shift key required at any step.

### Proximity ordering in `buildLabelMap`

Add an optional `cursorTextOffset` parameter. When provided:

1. Collect **all** word-start positions across the visible buffer into a flat
   array, each annotated with `textOffset`.
2. Skip one-character words. Since labels occupy two visible columns, labeling
   a single-character word would spill into the next column and can visually
   merge with a neighboring label; Helix also avoids these jump targets.
3. Sort by `|textOffset - cursorTextOffset|` ascending.  
   Tie-break: forward words (offset ≥ cursor) before backward words at equal
   distance so the post-cursor word wins a tie.
4. Assign labels in that sorted order: `aa`, `ab`, … `zz`.

### Two-keypress input flow (`handleLabelInput` in `editor.ts`)

```
labelMode = true, labelPrefix = null

First keypress:
  • Escape / non-printable → cancel
  • a-z letter that is a prefix of ≥1 label in labelMap
      → set labelPrefix = char, requestRender()
  • Anything else → cancel

Second keypress (labelPrefix ≠ null):
  • labelMap.get(labelPrefix + char) → jump if found, otherwise cancel
```

### Render changes

In `render()`:
- **No prefix yet**: `applyLabels(lines, labelMap, null)`  
  Every labeled word shows both characters of its label over the first two
  columns of the word (for example, `the dog goes` becomes `aae abg aces`).
- **Prefix typed**: `applyLabels(lines, labelMap, labelPrefix)`  
  Only labels starting with `labelPrefix` are shown; matching labels still
  display both characters.

---

## Files to modify

| File | Changes |
|------|---------|
| `extensions/helix-mode/label-overlay.ts` | New label alphabet constants; `buildLabelMap` proximity sort + `cursorTextOffset` param; `applyLabels` `prefixFilter` param |
| `extensions/helix-mode/editor.ts` | `labelPrefix` field; `resetPendingState`; `enterLabelMode` (pass cursor offset); `handleLabelInput` (two-step); `render` (pass prefix to `applyLabels`) |

---

## Reuse

- `lineColToOffset(lines, line, col)` — `buffer.ts` — already used in
  `editor.ts`; use in `enterLabelMode` to compute `cursorTextOffset`.
- `applyLabels` / `buildLabelMap` — `label-overlay.ts` — extend in-place,
  keeping existing call-sites backward-compatible via default params.

---

## Steps

### label-overlay.ts

- [ ] Replace `LABELS` with:
  ```ts
  const TWO_CHAR_CHARS = "abcdefghijklmnopqrstuvwxyz";  // 26
  ```
- [ ] Add `buildTwoCharLabels()` generator that yields `aa`…`zz` (676 strings).
- [ ] Change `buildLabelMap` to accept `cursorTextOffset?: number` as a new
  final parameter.
- [ ] Inside `buildLabelMap`:
  - Collect visible word-start positions for words with at least two characters
    into an array with `textOffset` (computed incrementally from
    `lineOffset + chunkStart + ci2`).
  - When `cursorTextOffset` is provided, sort the array by distance.
  - Iterate the sorted array, assigning from `buildTwoCharLabels()` (up to 676).
- [ ] Change `applyLabels` signature to accept `prefixFilter: string | null`
  (default `null`).
- [ ] In `applyLabels`:
  - When `prefixFilter` is `null`: display both label characters at the word
    start (`label[0]` at `visualCol`, `label[1]` at `visualCol + 1`).
  - When `prefixFilter` is set: skip labels that don't start with the prefix;
    matching labels still display both characters.

### editor.ts

- [ ] Add `private labelPrefix: string | null = null;` field.
- [ ] In `resetPendingState()`: add `this.labelPrefix = null;`.
- [ ] In `enterLabelMode()`: compute `cursorTextOffset` via `lineColToOffset`
  and pass it as the new `buildLabelMap` argument.
- [ ] In `render()`: pass `this.labelPrefix` to `applyLabels`.
- [ ] Rewrite `handleLabelInput()` with the two-step logic described above.

---

## Verification

1. **Manual smoke test** — open a long file in helix-mode, press `gw`:
   - Confirm two-character labels appear as lowercase pairs near the cursor (both forward and backward).
   - Press the two-character label shown over a word → cursor jumps.
   - If pausing after the first lowercase letter, re-render keeps two-character labels for matching prefixes only.
   - Press `Escape` at either step → label mode cancelled, no jump.
2. **Edge cases** — fewer than 676 visible eligible words: only as many
   two-char labels as there are word-starts are shown; the rest are simply
   unlabeled. One-character words are not eligible for labels.
3. **Existing tests** — `npm test` (or equivalent) should still pass; no
   behavioral change to any non-`gw` path.
