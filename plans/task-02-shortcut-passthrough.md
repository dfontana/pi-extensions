# Task 02 — Shortcut Passthrough in Normal/Select Mode

## Summary of the Problem

### Root cause

In `extensions/helix-mode/editor.ts`, the `handleNormalInput()` method ends with this guard (lines 384–386):

```typescript
// ── Pass control sequences through; swallow printable chars in normal ─
if (data.length === 1 && data.charCodeAt(0) >= 32) return;
super.handleInput(data);
```

Any key that reaches this point without matching a Helix binding is either silently discarded (if it is a printable ASCII character, charCode ≥ 32) or passed to `super.handleInput(data)` (if it is a control sequence, charCode < 32 or multi-byte escape).

### Why this breaks shortcut passthrough

`CustomEditor.handleInput()` (the base class) processes input in this order:
1. `this.onExtensionShortcut?.(data)` — fires extension-registered shortcuts, returns `true` if matched
2. `this.keybindings.matches(data, "app.clipboard.pasteImage")` — specific paste-image check
3. `this.keybindings.matches(data, "app.interrupt")` — abort/escape
4. `this.keybindings.matches(data, "app.exit")` — Ctrl+D
5. Loop over `this.actionHandlers` checking `this.keybindings.matches(data, action)` — all other app actions
6. Falls through to `Editor.handleInput(data)` — raw text insertion

The bug: steps 1–5 are **never reached for printable characters in Normal/Select mode**. `HelixEditor.handleNormalInput()` returns early at line 385 before control is returned to `super.handleInput`. Only control sequences (step 6 can never insert text for them anyway) survive to `super.handleInput`.

### Concrete failure scenarios

| Scenario | Expected | Actual |
|---|---|---|
| Extension registers `pi.registerShortcut("f5", …)` — F5 is a multi-byte sequence | Fires in Normal mode | Works (passes to super) |
| Extension registers `pi.registerShortcut("ctrl+k", …)` — charCode 11 | Fires in Normal mode | Works (control sequence, < 32) |
| Extension registers a bare printable shortcut (e.g. key reported as `"?"` or `"p"` in some terminal configs) | Fires in Normal mode if not a Helix key | Silently swallowed |
| App action `app.model.select` bound to a printable key via `keybindings.json` | Fires in Normal mode | Silently swallowed |
| App action `app.session.new` re-bound by user to a printable char | Fires | Silently swallowed |

### Secondary dispatch gap (line 249)

The dispatch in `handleInput` (lines 238–249) also never offers printable chars to the shortcut layer for Normal/Select mode, because it delegates immediately to `handleNormalInput` without a pre-check:

```typescript
// line 238-249
if (this.mode === "insert") {
  if (matchesKey(data, "escape")) { ... }
  super.handleInput(data);   // ← INSERT correctly delegates everything to super
  return;
}

// ── NORMAL / SELECT mode ──────────────────────────────────────────────
this.handleNormalInput(data);  // ← no shortcut pre-check
```

INSERT mode works correctly because `super.handleInput(data)` is called for every key (after the Escape intercept), so extension shortcuts and app actions always get a chance.

---

## Proposed Changes

### Strategy

Insert a shortcut-intercept block in `handleInput()` (the dispatch method, lines 248–249) **before** `handleNormalInput(data)` is called. This is the correct seam because:

- It mirrors the INSERT path, which calls `super.handleInput(data)` for all unhandled keys.
- It keeps `handleNormalInput` focused on pure Helix semantics.
- The existing swallow guard in `handleNormalInput` (line 385) becomes correct by narrowed invariant: by the time a printable char reaches it, we have already confirmed it is not a registered shortcut.

No change is required to `handleNormalInput` itself.

### Change 1 — `handleInput` dispatch (editor.ts, around line 248)

**Before:**
```typescript
    // ── NORMAL / SELECT mode ──────────────────────────────────────────────
    this.handleNormalInput(data);
  }
```

**After:**
```typescript
    // ── NORMAL / SELECT mode ──────────────────────────────────────────────
    // Before handing off to the modal handler, give registered shortcuts and
    // app-level actions first chance at printable chars.  This prevents the
    // modal handler's catch-all swallow from hiding a key that belongs to a
    // global shortcut.
    //
    // Control sequences (charCode < 32 or multi-byte) are forwarded directly
    // to handleNormalInput, which already passes unrecognized ones to super.
    // They never produce text insertion, so no pre-check is needed for them.
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Step 1: extension-registered shortcuts.  The callback fires the
      // shortcut as a side-effect and returns true if it matched.
      if (this.onExtensionShortcut?.(data)) return;

      // Step 2: app-level keybinding actions registered via onAction().
      for (const [action, handler] of this.actionHandlers) {
        if (this.keybindings.matches(data, action)) {
          handler();
          return;
        }
      }
    }
    this.handleNormalInput(data);
  }
```

### Why `this.keybindings` and `this.actionHandlers` are accessible

`CustomEditor` (the direct superclass) declares both as class fields without a `private` modifier:

```javascript
// custom-editor.js (dist)
export class CustomEditor extends Editor {
    keybindings;           // KeybindingsManager — has .matches(data, actionId)
    actionHandlers = new Map();
    onExtensionShortcut;   // ((data: string) => boolean) | undefined
    ...
```

`HelixEditor` inherits all three. No constructor change is needed; `this.keybindings` is already available from the superclass without re-storing the constructor argument.

### What is NOT changed

- `handleNormalInput` lines 384–386 — the swallow guard stays. By the time a printable char reaches it, the shortcut pre-check above has already run and found no match.
- INSERT mode path — already correct; `super.handleInput(data)` is called for all keys.
- Label mode, mini-prompt mode, pending-replace mode — these are consumed before the Normal/Select branch and are unaffected.
- The `pendingReplace` handler (lines 227–235) calls `super.handleInput(data)` directly for the replacement char — this is intentional text insertion and should remain as-is.

---

## Conflict Policy

### Rule 1 — Helix modal bindings take absolute precedence

If a key is claimed by a Helix binding (any branch with an explicit `return` before the swallow guard in `handleNormalInput`), the Helix action fires and the global shortcut is **never consulted**. This is intentional: the user is in a named mode where that key has a documented meaning.

Affected keys in Normal/Select mode (illustrative, not exhaustive):
`h l j k w b e 0 $ g i a o O v d c r x > < s * n N` and arrow/Home/End aliases.

### Rule 2 — Unbound printable chars in Normal/Select mode fire shortcuts, then are swallowed

A printable char (charCode ≥ 32, length 1) that does NOT match any Helix binding goes through the following waterfall in Normal/Select mode:

1. Extension shortcut registered via `pi.registerShortcut()` — fires if matched, returns.
2. App action registered via `onAction()` / `keybindings.json` — fires if matched, returns.
3. Neither matched — key is silently swallowed (no text insertion, no error).

### Rule 3 — Control sequences always pass through

Multi-byte sequences and chars with charCode < 32 skip the shortcut pre-check and are forwarded directly to `handleNormalInput`, which passes unrecognized ones to `super.handleInput(data)`. They carry no text-insertion risk and already reach the app keybinding layer via the existing `super.handleInput` call at the bottom of `handleNormalInput`.

### Rule 4 — Extension authors: prefer non-printable shortcuts for cross-mode use

Shortcuts using printable characters (e.g. `"p"`, `"?"`) will silently not fire in Normal/Select mode if that character is a Helix binding. To guarantee a shortcut fires in all modes, use a control sequence: `ctrl+k`, `alt+p`, `f5`, etc. Document this in the extension's README.

### Rule 5 — Insert mode is fully transparent

In Insert mode, `super.handleInput(data)` is called for every key after the Escape intercept. All shortcuts — printable or not — fire normally. There is no conflict between Insert mode and global shortcuts.

---

## Acceptance Criteria Checklist

- [ ] **Modal bindings prevent text insertion in Normal/Select mode.**
  - Pressing an unrecognized printable key (e.g., `"?"`) in Normal mode does not insert a character into the buffer.
  - All existing Helix bindings (`h`, `l`, `j`, `k`, `w`, `b`, `e`, `0`, `$`, `g`, `i`, `a`, `o`, `O`, `v`, `d`, `c`, `r`, `x`, `>`, `<`, `s`, `*`, `n`, `N`) continue to work as before.

- [ ] **Extension shortcuts fire in Normal/Select mode (printable-char shortcuts).**
  - An extension that calls `pi.registerShortcut("p", …)` where `"p"` is not a Helix binding fires the shortcut handler when `p` is pressed in Normal mode.
  - An extension shortcut on a key that IS a Helix binding (e.g., `d`) does NOT fire; the Helix action fires instead.

- [ ] **Extension shortcuts fire in Normal/Select mode (control-sequence shortcuts).**
  - An extension shortcut on `ctrl+k` (or any non-printable key) fires in Normal mode (regression guard — this already worked before the fix).

- [ ] **App-level keybinding actions fire in Normal/Select mode when bound to printable chars.**
  - If the user remaps an app action (e.g., `app.model.select`) to a printable char in `keybindings.json`, pressing that char in Normal mode triggers the action rather than being swallowed.

- [ ] **Insert mode behavior is unchanged.**
  - All keys in Insert mode (excluding Escape) continue to pass through to `super.handleInput(data)` without any extra interception.

- [ ] **Conflict policy is documented.**
  - This plan (or a condensed version in `extensions/helix-mode/README.md`) records the precedence order: Helix bindings → extension shortcuts → app actions → swallow.

- [ ] **No regressions in existing Helix tests** (if a test suite exists) or manual verification of the full Normal/Select keymap.

---

## Implementation Notes

### Files to change

| File | Change |
|---|---|
| `extensions/helix-mode/editor.ts` | Insert shortcut pre-check block before `this.handleNormalInput(data)` (lines 248–249). No other edits. |

### Files to read before implementing

| File | Why |
|---|---|
| `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js` | Verify field names and `matches` call signature before referencing `this.actionHandlers` and `this.onExtensionShortcut`. |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.d.ts` | Confirm `KeybindingsManager.matches(data, actionId)` signature. |

### Diff sketch (minimal)

```diff
-    // ── NORMAL / SELECT mode ──────────────────────────────────────────────
-    this.handleNormalInput(data);
+    // ── NORMAL / SELECT mode ──────────────────────────────────────────────
+    // Intercept printable chars that are registered as global shortcuts or
+    // app actions before the modal handler can swallow them.
+    if (data.length === 1 && data.charCodeAt(0) >= 32) {
+      if (this.onExtensionShortcut?.(data)) return;
+      for (const [action, handler] of this.actionHandlers) {
+        if (this.keybindings.matches(data, action)) {
+          handler();
+          return;
+        }
+      }
+    }
+    this.handleNormalInput(data);
```

Total lines changed: +10 (0 deletions of existing logic).
