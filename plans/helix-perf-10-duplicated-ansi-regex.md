# Task 10: Duplicated ANSI regex — maintenance risk

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `label-overlay.ts:40` vs `label-overlay.ts:98`

`stripAnsi()` uses an inline regex literal that must "stay in sync" with `ANSI_RE` defined 60 lines below. This violates DRY and creates a latent bug vector.

**Fix:** Extract to a shared constant or have `stripAnsi()` reference `ANSI_RE`.
