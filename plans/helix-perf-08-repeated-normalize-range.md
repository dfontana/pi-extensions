# Task 8: Repeated `normalizeRange` computation across helpers

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `selection.ts`

`isNonEmpty`, `selectionCharCount`, `selectionLineRange`, and `selectionText` all independently call `normalizeRange`. When used together (as in `actionDelete` which checks `isNonEmpty` then calls `getEffectiveRange`), the offset computation is redundantly repeated.

**Fix:** Compute range once and pass it through, or unify into a single `getSelectionInfo()` that returns all needed data.
