# Task 03 — Remove `private tui` Shadow in `HelixEditor`

## Problem Summary

**File:** `extensions/helix-mode/editor.ts`

The inheritance chain is:

```
HelixEditor → CustomEditor → Editor
```

`Editor` (from `@earendil-works/pi-tui`) declares at line 37 of its type declaration:

```typescript
protected tui: TUI;
```

`CustomEditor` (from `@earendil-works/pi-coding-agent`) extends `Editor` and does not redeclare `tui`, so the `protected tui` field is inherited transparently.

`HelixEditor`, however, re-declares the field with a narrower visibility at **line 101**:

```typescript
// ── TUI reference (for requestRender) ────────────────────────────────────
private tui: TUI;
```

And then redundantly re-assigns it in the constructor at **line 105**:

```typescript
constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
  super(tui, theme, keybindings);   // base Editor already stores tui as protected
  this.tui = tui;                   // ← redundant; also writes to the private shadow
}
```

### Why this is a problem

- **Private shadows protected** — within `HelixEditor`, `this.tui` resolves to the `private` field, not the inherited `protected` one. TypeScript issues a diagnostic (TS2415 or TS4119) because a subclass field cannot re-declare a base `protected` property as `private`.
- **Redundant assignment** — `super(tui, theme, keybindings)` already assigns `tui` to `this.tui` (the base `protected` slot) before `this.tui = tui` runs; the extra write is dead code once the shadow is removed.
- **Future breakage** — any future change that reads `this.tui` from a `CustomEditor` reference would bypass the private shadow and silently diverge from what `HelixEditor` writes if the two values were ever to differ.

### All call sites

Every reference to `this.tui` in the file after the constructor is a `this.tui.requestRender()` call. These are spread across ~25 locations (lines 233–793) and all continue to work correctly once they read through the inherited `protected tui` instead of the removed private shadow.

---

## Proposed Changes

### Change 1 — Remove the private field declaration and comment (lines 100–101)

**Before (`editor.ts` lines 99–106):**

```typescript
  // ── TUI reference (for requestRender) ────────────────────────────────────
  private tui: TUI;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.tui = tui;
  }
```

**After:**

```typescript
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
  }
```

Specifically, two deletions are required:

1. Delete the comment line and the `private tui: TUI;` declaration (lines 100–101).
2. Delete the `this.tui = tui;` assignment inside the constructor (line 105).

### Change 2 — Retain the `TUI` type import

The `TUI` type is still needed as the parameter type in the constructor signature:

```typescript
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
```

**No change required** — this import stays as-is.

### No other changes

All `this.tui.requestRender()` call sites throughout the file continue to work unchanged; they will now resolve through the inherited `protected tui` set by the `Editor` base constructor.

---

## Acceptance Criteria

- [ ] `extensions/helix-mode/editor.ts` no longer contains a `private tui` field declaration.
- [ ] The `HelixEditor` constructor no longer contains a `this.tui = tui;` assignment.
- [ ] `this.tui` is used (read) throughout the class body without any explicit local declaration — it resolves to the inherited `protected tui` from `Editor`.
- [ ] The `TUI` type import at the top of the file is retained (used by the constructor parameter).
- [ ] Running `tsc --noEmit` (or equivalent type-check) on the extension produces no errors related to field shadowing (TS2415 / TS4119) or unresolved `tui` references.
- [ ] All `this.tui.requestRender()` calls throughout the file continue to compile and behave identically at runtime.
