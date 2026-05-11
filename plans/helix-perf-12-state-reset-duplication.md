# Task 12: State reset duplication across mode transitions

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `editor.ts:93-118`

All three mode-transition methods (`enterInsert`, `enterNormal`, `enterSelect`) reset overlapping subsets of state (`pendingPrefix`, `pendingReplace`, `labelMode`, `labelMap`).

**Fix:** Extract a shared `resetPendingState()` helper to eliminate repetition and reduce risk of forgetting to clear a field when adding new pending states.
