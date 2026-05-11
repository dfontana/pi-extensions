# Task 3: `computeSelectionSpans()` recomputes word-wrap for ALL lines

**Severity:** Medium  
**Frequency:** Every render in select mode  
**File:** `label-overlay.ts:175-222`

Even when a selection covers only line 8, this function iterates from line 0 and calls `wordWrapLine()` on every preceding line to track `visualRow`. The word-wrap done here **duplicates** the work `super.render(width)` already did internally. There is no caching or sharing of layout results between the parent's render and the selection logic.

**Fix:** Cache word-wrap results per-render (keyed on text + width), or compute a cumulative visual-row index once and reuse it across `computeSelectionSpans` and `buildLabelMap`.
