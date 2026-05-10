# Task 01 — Editor Composition: Save and Restore Previous Editor Factory

## Summary of the Problem

`extensions/helix-mode/index.ts` manages the TUI editor component in three
places, each with the same flaw: it does not account for editor components
installed by other extensions.

| Location | Current behaviour | Problem |
|---|---|---|
| `session_start` handler | Calls `ctx.ui.setEditorComponent(helixFactory)` unconditionally | Clobbers any factory a previously-loaded extension already set |
| `session_shutdown` handler | Calls `ctx.ui.setEditorComponent(undefined)` | Always resets to the built-in default, erasing any unrelated plugin's factory |
| `/helix on` command path | Calls `setEditorComponent(helixFactory)` even when Helix is already installed | Can double-wrap the editor if the command is run twice |
| `/helix off` / toggle-off command paths | Calls `setEditorComponent(undefined)` | Same problem as `session_shutdown`: always resets to default instead of the factory that was in place before Helix was installed |

The Pi extension API explicitly supports this pattern via `ctx.ui.getEditorComponent()`, which returns the currently-installed factory before we overwrite it, and `ctx.ui.setEditorComponent(factory | undefined)` which accepts that saved factory for restoration.

---

## Proposed Changes

### 1. Add two tracking variables to the extension closure

```typescript
// The factory that was installed before we set our own.
// Captured in installHelix(); restored in uninstallHelix().
let previousFactory: ReturnType<typeof ctx.ui.getEditorComponent> | undefined;

// True while our helix factory is the currently-installed component.
let helixInstalled = false;
```

> **Scope note:** Both variables live in the same closure as `helixEnabled`.  
> Because Pi creates a fresh extension instance for every session (each `/new`,
> `/resume`, `/fork`, and `/reload` tears down the old runtime), there is no
> cross-session leakage.

### 2. Extract `installHelix` / `uninstallHelix` helpers

Replace the four inline `setEditorComponent` call sites with two named helpers
that handle the save/restore logic in one place:

```typescript
function installHelix(ctx: ExtensionContext): void {
  if (helixInstalled) return;           // already installed — do not double-wrap
  previousFactory = ctx.ui.getEditorComponent();   // capture whatever is there now
  ctx.ui.setEditorComponent(
    (tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings),
  );
  helixInstalled = true;
}

function uninstallHelix(ctx: ExtensionContext): void {
  if (!helixInstalled) return;          // nothing to undo
  ctx.ui.setEditorComponent(previousFactory);      // restore previous, not undefined
  helixInstalled = false;
  previousFactory = undefined;
}
```

`ExtensionContext` is the type of the second argument to any `pi.on()` handler.
No new imports are required; the type can be inlined or referenced via the
existing `ExtensionAPI` import.

### 3. Update `session_start`

```typescript
// Before
pi.on("session_start", (_event, ctx) => {
  if (!helixEnabled) return;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings));
});

// After
pi.on("session_start", (_event, ctx) => {
  if (!helixEnabled) return;
  installHelix(ctx);
});
```

### 4. Update `session_shutdown`

```typescript
// Before
pi.on("session_shutdown", (_event, ctx) => {
  ctx.ui.setEditorComponent(undefined);
});

// After
pi.on("session_shutdown", (_event, ctx) => {
  uninstallHelix(ctx);
});
```

### 5. Update the `/helix` command to toggle only

Remove the explicit `on`/`off` argument paths — they are redundant with the toggle and add maintenance burden. The command always toggles.

```typescript
// Before (spread across on/off/toggle cases)
if (arg === "on") { ... }
if (arg === "off") { ... }
// toggle fallback...

// After — toggle only
if (helixEnabled) {
  helixEnabled = false;
  uninstallHelix(ctx);
  ctx.ui.notify("Helix mode off", "info");
} else {
  helixEnabled = true;
  installHelix(ctx);
  ctx.ui.notify("Helix mode on", "info");
}
```

### Complete updated `index.ts`

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HelixEditor } from "./editor.js";

export default function (pi: ExtensionAPI): void {
  let helixEnabled = true;

  // Saved factory from before we installed our own.
  let previousFactory: Parameters<typeof ctx.ui.setEditorComponent>[0] | undefined;
  let helixInstalled = false;

  function installHelix(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]): void {
    if (helixInstalled) return;
    previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings),
    );
    helixInstalled = true;
  }

  function uninstallHelix(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]): void {
    if (!helixInstalled) return;
    ctx.ui.setEditorComponent(previousFactory);
    helixInstalled = false;
    previousFactory = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!helixEnabled) return;
    installHelix(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    uninstallHelix(ctx);
  });

  pi.registerCommand("helix", {
    description: "Toggle Helix modal editing on/off.",
    handler: (_args, ctx) => {
      // Always toggle — no on/off argument paths
      if (helixEnabled) {
        helixEnabled = false;
        uninstallHelix(ctx);
        ctx.ui.notify("Helix mode off", "info");
      } else {
        helixEnabled = true;
        installHelix(ctx);
        ctx.ui.notify("Helix mode on", "info");
      }
    },
  });
}
```

> **Type annotation note:** The `ctx` parameter types above use deeply-nested
> `Parameters<…>` gymnastics for illustration. In practice it is cleaner to
> import `ExtensionContext` and `ExtensionCommandContext` from
> `@earendil-works/pi-coding-agent` and annotate the helpers with those types
> directly, since `installHelix` is called from both event handlers and the
> command handler.

---

## Acceptance Criteria Checklist

- [ ] **Capture previous factory on session start.** When `session_start` fires and
      `helixEnabled` is `true`, the code calls `ctx.ui.getEditorComponent()` before
      calling `setEditorComponent`, and stores the result in `previousFactory`.

- [ ] **Toggle-off restores previous factory.** When `/helix` is toggled off,
      `setEditorComponent(previousFactory)` is called, not
      `setEditorComponent(undefined)`. If `previousFactory` was `undefined`
      (no other extension had set one), the default editor is restored — same
      visible result as before, but correct.

- [ ] **Toggle-on does not double-wrap.** Toggling on when Helix is already
      installed (`helixInstalled === true`) is a no-op in `installHelix`.
      The factory is not replaced and `previousFactory` is not overwritten.
      (This guards against state drift, not a user-facing on/off command.)

- [ ] **`session_shutdown` restores selectively.** `uninstallHelix` is a no-op when
      `helixInstalled` is `false`. When it is `true`, it restores only the factory
      that was saved at installation time. It never calls
      `setEditorComponent(undefined)` unconditionally.

- [ ] **No changes to `editor.ts`.** `HelixEditor` and its rendering/input logic are
      unchanged; this fix is purely in `index.ts`.

- [ ] **Reload cycle is safe.** On `/reload`, Pi fires `session_shutdown` (restores
      `previousFactory`) then tears down the extension instance. The new instance
      starts with `previousFactory = undefined` and `helixInstalled = false`, so the
      next `session_start` captures whatever state other extensions establish in their
      own `session_start` handlers for the new instance.
