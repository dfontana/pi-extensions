# Task 08 — Overlay Layout Fix

**Files affected:** `extensions/helix-mode/label-overlay.ts`, `extensions/helix-mode/buffer.ts`,
`extensions/helix-mode/editor.ts`

---

## 1. Audit: local `wordWrapLine` vs Pi's version

### Local version (`buffer.ts` — `wordWrapLine`)

```typescript
export function wordWrapLine(line: string, maxWidth: number): VisualChunk[] {
  if (maxWidth <= 0) maxWidth = 1;
  if (line.length === 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  ...
  while (pos < line.length) {
    const remaining = line.slice(pos);
    if (remaining.length <= maxWidth) { /* fast path */ }
    // Find last word-break by scanning backwards within maxWidth
    // Falls back to hard break at maxWidth chars
    pos += breakAt;
    while (pos < line.length && line[pos] === " ") pos++;  // skip leading spaces
  }
}
```

**Critical flaws:**

| Issue | Location | Effect |
|---|---|---|
| Uses `string.length` / `remaining.length` as column count | fast path, break scan, `breakAt` | CJK/emoji chars count as 1 col, not 2 — wrapping fires too late |
| Iterates raw JavaScript chars, not grapheme clusters | entire loop | multi-codepoint graphemes (e.g. skin-tone emoji) are split mid-glyph |
| No paste-marker awareness | entire function | paste marker text `[paste #1 +5 lines]` is treated as ~23 individual chars; if it straddles a wrap boundary the chunk `endIndex` will differ from what Pi computes |
| Word-break scan direction | reverse scan within `remaining` | different from Pi's forward scan with backtracking; minor positional differences on some inputs |

### Pi's version (`@earendil-works/pi-tui/dist/components/editor.js` — `wordWrapLine`)

```javascript
export function wordWrapLine(line, maxWidth, preSegmented) {
  const lineWidth = visibleWidth(line);   // grapheme-aware column count
  if (lineWidth <= maxWidth) { ... }
  const segments = preSegmented ?? [...baseSegmenter.segment(line)];
  // Forward scan; records wrap opportunity after last space before a word
  // Backtracks to wrap opp when current grapheme would overflow
  // Falls back to force-break if backtrack wouldn't help
}
```

**Correct behaviours local version lacks:**
- `visibleWidth()` uses `Intl.Segmenter` + `get-east-asian-width` for precise column counts
- `preSegmented` parameter allows the caller to pass paste-marker-aware segments so markers are atomic
- Handles wide graphemes that are themselves wider than `maxWidth` via recursive sub-wrapping

### What Pi exports publicly from `@earendil-works/pi-tui`

The main package index exports (`dist/index.d.ts`):

| Symbol | Available? | Notes |
|---|---|---|
| `visibleWidth(str)` | **YES** | Correct column-width via graphemes + east-asian-width |
| `wrapTextWithAnsi(text, width)` | **YES** | Wraps ANSI-rendered text; tracks SGR across breaks. Not a replacement for `wordWrapLine` on raw editor lines. |
| `truncateToWidth(text, maxWidth, ellipsis?, pad?)` | **YES** | Used in editor.ts already |
| `wordWrapLine(line, maxWidth, preSegmented?)` | **NO** | Exported from `editor.js` but NOT re-exported from the package index |
| `getSegmenter()` | **NO** | Internal utility |

`wordWrapLine` is a named ES export in `dist/components/editor.js` and its types are in
`dist/components/editor.d.ts`. The `@earendil-works/pi-tui` package has **no `exports` map**,
so deep imports reach it at runtime. However this is an implementation path, not a public API.

### `scrollOffset` and `lastWidth` accessibility

From `dist/components/editor.d.ts`:

```typescript
export declare class Editor ... {
  private paddingX;    // accessed via getPaddingX() — public method ✓
  private lastWidth;   // no getter; HelixEditor works around with this.lastRenderWidth
  private scrollOffset;// no getter; must cast at runtime
  protected tui: TUI;  // accessible in subclasses ✓
```

At JavaScript runtime `scrollOffset` is a plain class field (no `#` hard-private). It is accessible
via `(this as any).scrollOffset`. `tui` is `protected`, so `this.tui.terminal.rows` is reachable
from `HelixEditor` without casts.

---

## 2. Bug inventory

### Bug A — Wrong content width formula (highest impact)

**Location:** `label-overlay.ts`, both `buildLabelMap` and `computeSelectionSpans`

```typescript
// CURRENT — wrong
const contentWidth = Math.max(1, width - paddingX);
```

Pi's `render()` computes:

```javascript
const maxPadding  = Math.max(0, Math.floor((width - 1) / 2));
const clampedPad  = Math.min(this.paddingX, maxPadding);
const contentWidth = Math.max(1, width - clampedPad * 2);   // both sides
const layoutWidth  = Math.max(1, contentWidth - (clampedPad ? 0 : 1)); // cursor col
this.lastWidth = layoutWidth; // ← the value used in wordWrapLine calls
```

The overlay uses `width - paddingX` (one side only) instead of `width - paddingX * 2 - cursor_reserve`.

Concrete error for the default `paddingX = 1`, `width = 80`:
- Pi uses `layoutWidth = 80 - 2 = 78`
- Overlay uses `contentWidth = 80 - 1 = 79` → **off by 1 column**

Result: wrap points fire one column later in the overlay than in Pi's renderer. Labels on the
second wrap chunk of a long line are placed one row too early; selection highlights on wrapped lines
are off by one visual row.

### Bug B — Scroll offset ignored (medium impact, triggered only when editor scrolls)

**Location:** `label-overlay.ts` (`buildLabelMap`, `computeSelectionSpans`), `editor.ts`
(`enterLabelMode`, `render`)

Both functions start `visualRow = topBorderRows` and count upwards, treating visual row 0 as
rendered row 0 (plus border). When `scrollOffset > 0` this breaks:

- Visual rows `[0, scrollOffset)` are not rendered at all — their labels are placed at negative
  rendered rows (never drawn) but consume label slots (`a`, `b`, …).
- Visual rows `[scrollOffset, scrollOffset + maxVisibleLines)` are rendered at rows
  `topBorderRows … topBorderRows + maxVisibleLines - 1`.
- Visual rows at `≥ scrollOffset + maxVisibleLines` are below the fold (not rendered) but would
  receive labels.

Correct mapping:
```
renderedRow = topBorderRows + (absoluteVisualRow - scrollOffset)
```

### Bug C — Wide graphemes and grapheme boundaries (medium impact)

**Location:** `buffer.ts` `wordWrapLine`

Using `string.length` for column widths means:
- `"中文"` (2 chars, 4 cols) is treated as width 2 → wraps 2 columns too late
- Emoji with ZWJ sequences (e.g. `"👨‍👩‍👧"` = 1 grapheme, 2 cols, 8 code units) behaves as width 8 in
  the local code but width 2 in Pi's renderer

Result: chunk `startIndex`/`endIndex` values diverge from Pi's after any wide character, so every
label and highlight after that point is at the wrong column.

### Bug D — Paste marker unawareness (low impact, rare)

**Location:** `buffer.ts` `wordWrapLine`

When the editor contains a paste marker like `[paste #1 +47 lines]`, Pi treats it as a single
atomic grapheme during wrapping. The local code treats it as ~23 individual ASCII chars. If the
marker straddles a computed wrap boundary (unlikely in practice but possible), the chunk
`endIndex` will differ from Pi's, offsetting all subsequent labels.

---

## 3. Proposed changes

### 3.1 Fix content width formula — `label-overlay.ts`

Extract a shared helper at the top of `label-overlay.ts` (or as a private utility) that exactly
replicates Pi's width calculation:

```typescript
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Compute the layout width Pi's Editor uses for word-wrap, given the render
 * width and the editor's paddingX.  Mirrors Editor.render() exactly.
 */
function computeLayoutWidth(width: number, paddingX: number): number {
  const maxPadding  = Math.max(0, Math.floor((width - 1) / 2));
  const clamped     = Math.min(paddingX, maxPadding);
  const contentWidth = Math.max(1, width - clamped * 2);
  return Math.max(1, contentWidth - (clamped ? 0 : 1));
}
```

Replace both occurrences of `const contentWidth = Math.max(1, width - paddingX)` with a call to
`computeLayoutWidth(width, paddingX)`. The variable can remain named `contentWidth` (or be renamed
`layoutWidth` to match Pi's internals) — the important thing is the formula.

### 3.2 Add scroll offset support — `label-overlay.ts` + `editor.ts`

**`label-overlay.ts` — `buildLabelMap` signature change:**

```typescript
export function buildLabelMap(
  lines: string[],
  width: number,
  topBorderRows = 1,
  paddingX = 1,
  scrollOffset = 0,       // new
  maxVisibleLines = 9999, // new (large default = "no clip" for callers that don't scroll)
): LabelMap
```

Inside the loop, after computing `absoluteVisualRow = visualRow + ci` for a chunk:

```typescript
const renderedRow = topBorderRows + (absoluteVisualRow - scrollOffset);
// Skip chunks that are above the viewport (scrolled off)
if (renderedRow < topBorderRows) continue;
// Stop once we're below the visible area
if (renderedRow >= topBorderRows + maxVisibleLines) break;
```

Use `renderedRow` instead of `visualRow + ci` when inserting into the map.

Apply the same pattern to `computeSelectionSpans`:

```typescript
export function computeSelectionSpans(
  lines: string[],
  startOffset: number,
  endOffset: number,
  width: number,
  topBorderRows = 1,
  paddingX = 1,
  scrollOffset = 0,       // new
  maxVisibleLines = 9999, // new
): VisualSpan[]
```

**`editor.ts` — pass scroll offset from HelixEditor:**

`scrollOffset` is declared `private` in the TypeScript types but is a regular JS field at runtime.
Expose it in the call sites with a local cast:

```typescript
private getScrollOffset(): number {
  return (this as unknown as { scrollOffset: number }).scrollOffset ?? 0;
}

private getMaxVisibleLines(): number {
  const rows = this.tui.terminal.rows;
  return Math.max(5, Math.floor(rows * 0.3));
}
```

Update `enterLabelMode`:

```typescript
this.labelMap = buildLabelMap(
  lines, this.lastRenderWidth, 1, this.getPaddingX(),
  this.getScrollOffset(), this.getMaxVisibleLines(),
);
```

Update `render` (selection spans):

```typescript
const spans = computeSelectionSpans(
  logicalLines, start, end, width, 1, this.getPaddingX(),
  this.getScrollOffset(), this.getMaxVisibleLines(),
);
```

### 3.3 Fix `wordWrapLine` for wide graphemes — `buffer.ts`

Import `visibleWidth` from `@earendil-works/pi-tui` (already available transitively via `editor.ts`):

```typescript
import { visibleWidth } from "@earendil-works/pi-tui";
```

Rewrite the core of `wordWrapLine` to measure column widths with `visibleWidth` and to iterate
grapheme clusters via `Intl.Segmenter`. The return type (`VisualChunk` with `startIndex`/`endIndex`
as code-unit positions) stays the same.

Minimal diff approach — replace the per-character inner loop with a grapheme-segment loop:

```typescript
export function wordWrapLine(line: string, maxWidth: number): VisualChunk[] {
  if (maxWidth <= 0) maxWidth = 1;
  if (line.length === 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  if (visibleWidth(line) <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }

  const segmenter = new Intl.Segmenter();
  const segments = [...segmenter.segment(line)];
  const chunks: VisualChunk[] = [];
  let chunkStart = 0;     // code-unit offset of current chunk start
  let currentWidth = 0;
  let wrapOppIndex = -1;  // code-unit offset of last wrap opportunity
  let wrapOppWidth = 0;   // cumulative width up to (and including) trailing spaces

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!;
    const glyph = seg.segment;
    const gWidth = visibleWidth(glyph);
    const codeIdx = seg.index; // code-unit position in `line`

    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
        // Backtrack to wrap opportunity
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < codeIdx) {
        // Force break
        chunks.push({ text: line.slice(chunkStart, codeIdx), startIndex: chunkStart, endIndex: codeIdx });
        chunkStart = codeIdx;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }

    currentWidth += gWidth;

    // Record wrap opportunity: space followed by a non-space grapheme
    const isSpace = /\s/.test(glyph);
    const nextSeg = segments[si + 1];
    if (isSpace && nextSeg && !/\s/.test(nextSeg.segment)) {
      wrapOppIndex = nextSeg.index;
      wrapOppWidth = currentWidth;
    }
  }

  // Final chunk
  if (chunkStart < line.length) {
    chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  }
  return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}
```

This brings the local function in sync with Pi's algorithm for the common case. The only remaining
difference is paste-marker atomicity (see §3.4).

### 3.4 Paste marker handling — deferred / optional deep import

Pi's `wordWrapLine` accepts a `preSegmented` array from `segmentWithMarkers`, which collapses paste
marker spans into single atomic segments. The helix-mode local version has no access to the
editor's `validPasteIds()` (private) nor to `segmentWithMarkers` (unexported).

**Recommended approach (deferred):** treat paste markers as non-atomic for now. In practice a paste
marker is wide enough (`[paste #1 +47 lines]` = 23 cols) that it wraps at the word boundary before
it, not mid-marker. Misalignment only occurs if the marker happens to land exactly at a boundary.

**If full correctness is required later**, the options are:

1. **Deep import** (risky):
   ```typescript
   // @ts-ignore — not in public API
   import { wordWrapLine as piWordWrapLine } from
     "@earendil-works/pi-tui/dist/components/editor.js";
   ```
   Then call it from `label-overlay.ts` with a pre-segmented array built by casting
   `(this as any).segment(line)` in `HelixEditor` and passing the result down.

2. **Pi API request:** ask earendil-works to re-export `wordWrapLine` and expose a
   `getScrollOffset()` / `getMaxVisibleLines()` getter on `Editor`.

### 3.5 `applyLabels` — ANSI stripping is intentional

`applyLabels` currently strips all ANSI before overlaying label characters. This is noted in the
code as acceptable for the brief 1-keypress interaction. No change required here, but it is worth
noting that the overlay does not use the ANSI-preserving `highlightRange` path that
`applySelectionHighlight` uses. If label-mode is extended to show more context this could be
revisited.

---

## 4. How width is derived correctly

| Step | Pi `render()` | Overlay (current) | Overlay (after fix) |
|---|---|---|---|
| Raw render width | `width` arg | `width` arg | `width` arg |
| Clamp paddingX | `min(paddingX, floor((width-1)/2))` | not done | `computeLayoutWidth` helper |
| Content width | `width - clampedPad * 2` | `width - paddingX` (**wrong**) | `width - clampedPad * 2` |
| Layout width for wrap | `contentWidth - (pad ? 0 : 1)` | same as content width (**wrong**) | `contentWidth - (clamped ? 0 : 1)` |
| Stored for reuse | `this.lastWidth` | `this.lastRenderWidth` | same; passes to `buildLabelMap` |

For the default helix-mode configuration (`paddingX = 1`, `width = 80`):
- Pi layout width: `80 - 2 - 0 = 78`
- Current overlay content width: `80 - 1 = 79` (off by 1)
- Fixed overlay layout width: `78` ✓

---

## 5. Acceptance criteria checklist

- [ ] **Width formula** — `buildLabelMap` and `computeSelectionSpans` both use
  `computeLayoutWidth(width, paddingX)` that exactly mirrors Pi's `render()` formula; verified
  by unit test with `width=80, paddingX=1` → `layoutWidth=78`.

- [ ] **Scroll offset — labels** — `buildLabelMap` skips visual rows `< scrollOffset` and
  `>= scrollOffset + maxVisibleLines`; label characters appear on the correct rendered rows when
  the editor is scrolled.

- [ ] **Scroll offset — selection** — `computeSelectionSpans` emits `VisualSpan` entries with
  `row` values that fall within the rendered window only; no highlight applied to border rows or
  off-screen rows.

- [ ] **Wide graphemes** — local `wordWrapLine` uses `visibleWidth()` for all column-width
  checks; a line containing CJK text wraps at the same visual column as Pi's renderer; confirmed
  by unit test with `"中文ABC"` at `maxWidth = 4` producing chunk split after `"中文"`.

- [ ] **`gw` labels on wrapped lines** — pressing `gw` in normal mode with a long line that
  wraps at the terminal width shows labels on both the first and continuation visual rows; jumping
  to a label on a continuation row moves the cursor to the correct logical column.

- [ ] **Selection highlight on wrapped lines** — selecting a range that spans multiple wrapped
  visual rows shows reverse-video highlight on all visible rows in the range with correct start/end
  columns; no blank-row gap between wrapped segments.

- [ ] **Wide-char input** — entering CJK text in insert mode and then activating select mode
  produces selection highlight spanning the correct column range; the cursor block covers the
  correct 2-column glyph position.

- [ ] **Paste markers** — a line containing `[paste #N ...]` does not cause an off-by-N column
  error for labels/highlights on subsequent words (best-effort; full atomicity deferred to §3.4).

- [ ] **No regression — narrow ASCII** — all existing behaviours for ASCII-only input at
  standard terminal widths are unaffected.

---

## 6. File change summary

| File | Changes |
|---|---|
| `label-overlay.ts` | Add `computeLayoutWidth` helper; replace both `width - paddingX` usages; add `scrollOffset` + `maxVisibleLines` params to `buildLabelMap` and `computeSelectionSpans`; skip out-of-viewport rows |
| `buffer.ts` | Import `visibleWidth` from `@earendil-works/pi-tui`; rewrite `wordWrapLine` to use grapheme segmentation and column widths |
| `editor.ts` | Add `getScrollOffset()` and `getMaxVisibleLines()` private helpers; pass them to `buildLabelMap` and `computeSelectionSpans` call sites |
