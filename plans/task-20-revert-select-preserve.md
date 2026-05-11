# Task 20 — Revert Selection-Preservation Behavior

**File:** `extensions/helix-mode/editor.ts`

**Goal:** Remove the feature that keeps `this.selection` alive when Escape is pressed from Select mode. Escape from Select should call `enterNormal()` (which zeroes out the selection) and return to a fully clean Normal mode — matching the original behavior before the preservation feature was added.

---

## Affected Locations

### Location 1 — `getModeLabel()`: Normal-with-selection arm (lines 153–156)

**Current code:**
```typescript
// line 147
  private getModeLabel(): string {
    if (this.mode === "insert") return " INSERT ";
    if (this.mode === "select") {
      const charCount = this.getSelectionCharCount();
      return ` SELECT (${charCount}) `;
    }
    if (this.selection !== null) {          // line 153 ← REMOVE THIS BLOCK
      const charCount = this.getSelectionCharCount();
      return ` NORMAL (${charCount}) `;
    }
    return " NORMAL ";
  }
```

**Proposed after-state:**
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

**Rationale:** Normal mode always shows a plain label. The `NORMAL (N)` variant only existed to surface a retained selection that will no longer exist.

---

### Location 2 — `render()`: widened selection-highlight condition (line 177)

**Current code:**
```typescript
    if ((this.mode === "select" || this.mode === "normal") && this.selection && !this.labelMode) {
```

**Proposed after-state:**
```typescript
    if (this.mode === "select" && this.selection && !this.labelMode) {
```

**Rationale:** Highlights should only appear while the user is actively in Select mode. Normal mode never has a live selection after the revert, so the `|| this.mode === "normal"` guard is dead code.

---

### Location 3 — `handleNormalInput()`: Select→Normal Escape branch (lines 300–311)

**Current code:**
```typescript
  private handleNormalInput(data: string): void {
    // Escape in normal mode: pass to super (aborts agent, etc.)
    // Escape in select mode: return to normal without clearing selection position
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
```

**Proposed after-state:**
```typescript
  private handleNormalInput(data: string): void {
    // Escape in select mode: return to clean Normal (clears selection).
    // Escape in normal mode: pass to super (aborts agent, etc.).
    if (matchesKey(data, "escape")) {
      if (this.mode === "select") {
        this.enterNormal();
        this.tui.requestRender();
        return;
      }
```

**Rationale:** `enterNormal()` already sets `this.selection = null` and resets all pending state. The old inline mutation (`this.mode = "normal"` without clearing `this.selection`) was the entire mechanism of the preserved-selection feature. Replacing it with `enterNormal()` is the correct, clean revert.

---

### Location 4 — `handleNormalInput()`: second-Escape "clear retained selection" branch (lines 312–317)

**Current code:**
```typescript
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
```

**Proposed after-state:**
```typescript
      // Normal mode: forward to super so the app can handle Escape
      // (e.g. abort agent run).
      super.handleInput(data);
      return;
```

**Rationale:** This entire branch was introduced solely to clear the selection preserved by Location 3. Once Location 3 is reverted, Normal mode can never hold a non-null selection via the Escape path, making this branch unreachable dead code. Remove it entirely and simplify the comment.

---

## Summary of all changes

| # | Location | Lines | Change |
|---|----------|-------|--------|
| 1 | `getModeLabel()` | 153–156 | Delete the `if (this.selection !== null)` block |
| 2 | `render()` highlight guard | 177 | Remove `|| this.mode === "normal"` from condition |
| 3 | Select→Normal Escape | 303–310 | Replace inline `this.mode = "normal"` mutation with `this.enterNormal()` |
| 4 | Second-Escape branch | 312–317 | Delete the entire `if (this.mode === "normal" && this.selection !== null)` block; simplify comment |

---

## Acceptance Criteria

- [ ] Pressing Escape from Select mode calls `enterNormal()`, clearing `this.selection` and returning to a fully clean Normal mode in a single keypress.
- [ ] No second-Escape handling for "Normal with retained selection" — that branch is gone entirely.
- [ ] The `render()` selection highlight fires only when `this.mode === "select"`, never in Normal mode.
- [ ] `getModeLabel()` returns `" NORMAL "` unconditionally when `this.mode === "normal"` — no `NORMAL (N)` variant.
- [ ] Pressing Escape from a clean Normal mode still forwards the event to `super.handleInput(data)` (aborts agent run, etc.) — this path is untouched.
- [ ] All other behaviors (d/c/>/</s/* on a selection, n/N search navigation, gw jump labels, Insert mode) are unaffected.
