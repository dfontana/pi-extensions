# Task 09 — Use Theme Colors for Mode Labels in `HelixEditor`

## 1. Current `getModeLabelAnsi()` Implementation

**File:** `extensions/helix-mode/editor.ts`

```typescript
private getModeLabelAnsi(label: string): string {
    // Use raw ANSI since we don't have direct theme access here.
    // NORMAL → cyan bold, INSERT → dim, SELECT → yellow bold
    if (this.mode === "normal") return `\x1b[1;36m${label}\x1b[0m`;
    if (this.mode === "select") return `\x1b[1;33m${label}\x1b[0m`;
    return `\x1b[2m${label}\x1b[0m`;
}
```

**Hardcoded ANSI sequences:**

| Sequence | Meaning | Mode |
|---|---|---|
| `\x1b[1;36m` | Bold + Cyan (fg color 6) | NORMAL |
| `\x1b[1;33m` | Bold + Yellow (fg color 3) | SELECT |
| `\x1b[2m` | Dim | INSERT |
| `\x1b[0m` | Reset (appended to every label) | all |

The comment `"Use raw ANSI since we don't have direct theme access here"` is the false premise
this task fixes: `ctx.ui.theme` is available in the factory closure in `index.ts` and can be
threaded into the editor.

**Where the label is rendered** (also in `editor.ts`):

```typescript
// render() — bottom border mode label injection
const label = this.getModeLabel();
const labelWidth = visibleWidth(label);
const baseLine = lines[last] ?? "";
const truncated = truncateToWidth(baseLine, width - labelWidth, "");
const colored = this.getModeLabelAnsi(label);   // ← the only call site
lines[last] = truncated + colored;
```

---

## 2. Theme API Available via `ctx.ui.theme`

### `ctx.ui.theme` (type `Theme`)

`ExtensionUIContext` exposes a `readonly theme: Theme` property (declared in
`@earendil-works/pi-coding-agent` `dist/core/extensions/types.d.ts`, line 174).
This is the live theme instance that tracks the currently active theme.

```typescript
// In index.ts factory closure:
ctx.ui.theme   // → Theme instance
```

### `Theme` class API (from `theme.d.ts`)

```typescript
class Theme {
  fg(color: ThemeColor, text: string): string;    // wrap text in fg color + reset
  bold(text: string): string;                     // wrap text in bold
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  getFgAnsi(color: ThemeColor): string;           // raw ANSI for a fg color (no reset)
  getBgAnsi(color: ThemeBg): string;              // raw ANSI for a bg color (no reset)
  getColorMode(): "truecolor" | "256color";
}
```

`Theme` is exported from `@earendil-works/pi-coding-agent` (see `dist/index.d.ts` line 24).
The singleton `theme` is NOT re-exported at the index level, but the class is.

### Relevant `ThemeColor` tokens

| Token | Description | Proposed use |
|---|---|---|
| `accent` | Primary accent — logo, selected items, cursor | NORMAL label |
| `warning` | Warning states (typically amber/orange) | SELECT label |
| `muted` | Secondary text | INSERT label (replaces raw dim) |
| `dim` | Tertiary text | Alternative for INSERT |
| `success` | Success states (green) | Alternative for INSERT if green fits |
| `borderAccent` | Highlighted borders | Alternative for NORMAL |

**Recommended mapping (mirrors intent of current hardcodes):**

| Mode | Current ANSI | Proposed theme call |
|---|---|---|
| NORMAL | bold cyan | `theme.bold(theme.fg("accent", label))` |
| SELECT | bold yellow | `theme.bold(theme.fg("warning", label))` |
| INSERT | dim | `theme.fg("muted", label)` |

`"accent"` maps to primary accent (analogous to cyan in the dark built-in theme).
`"warning"` maps to warning color (analogous to yellow in the dark built-in theme).
`"muted"` provides secondary-text dimming without hardcoding ANSI dim (`\x1b[2m`).

---

## 3. Proposed Replacement

### 3a. `editor.ts` changes

1. **Add import** for `Theme` type:
   ```typescript
   import type { Theme } from "@earendil-works/pi-coding-agent";
   ```

2. **Add a `piTheme` field** and accept it via a getter so the label always reflects
   the current active theme even if theme is changed after session start:
   ```typescript
   private readonly getTheme: () => Theme;
   ```

3. **Update constructor signature** (insert before `keybindings`):
   ```typescript
   constructor(
     tui: TUI,
     theme: EditorTheme,
     getTheme: () => Theme,
     keybindings: KeybindingsManager,
   ) {
     super(tui, theme, keybindings);
     this.getTheme = getTheme;
   }
   ```

4. **Rename and rewrite** `getModeLabelAnsi(label: string): string`:
   ```typescript
   private getModeLabel(label: string): string {
     // Styled via active theme — no raw ANSI.
     const t = this.getTheme();
     if (this.mode === "normal") return t.bold(t.fg("accent", label));
     if (this.mode === "select") return t.bold(t.fg("warning", label));
     // INSERT: use muted (secondary text) — softer than normal/select emphasis.
     return t.fg("muted", label);
   }
   ```
   Update the single call site in `render()` accordingly (rename only).

5. **Remove the old comment** that claimed "no direct theme access here".

### 3b. `index.ts` changes

1. **Import `Theme` type** (for typing):
   ```typescript
   import type { Theme } from "@earendil-works/pi-coding-agent";
   ```
   *(Only needed if adding explicit types; import may be elided if only used as a
   type annotation on a lambda.)*

2. **Thread theme getter into factory**:
   ```typescript
   function installHelix(ctx: ExtensionContext | ExtensionCommandContext): void {
     if (helixInstalled) return;
     previousFactory = ctx.ui.getEditorComponent();
     ctx.ui.setEditorComponent(
       (tui, editorTheme, keybindings) =>
         new HelixEditor(tui, editorTheme, () => ctx.ui.theme, keybindings),
     );
     helixInstalled = true;
   }
   ```

   Using `() => ctx.ui.theme` (a getter thunk) rather than `ctx.ui.theme`
   (a snapshot) ensures that if the user changes theme mid-session the next
   render picks up the new colors without needing to reinstall the editor.

### 3c. Files NOT changed

- `label-overlay.ts` — label overlay for `gw` mode uses its own rendering
  and does not go through `getModeLabelAnsi`.
- `selection.ts`, `buffer.ts` — pure logic, no rendering.

---

## 4. Raw ANSI — Remaining Justified Uses

After the fix, raw ANSI remains only in:

| Location | Sequences | Reason |
|---|---|---|
| `SEQ` constant in `editor.ts` | `\x1b[D/C/A/B`, `\x01`, `\x05`, `\x1b[3~` | Control sequences for cursor movement and deletion forwarded to the underlying editor — not display styling. These have no theme equivalent. |
| `applySelectionHighlight` in `label-overlay.ts` (if applicable) | TBD per that module | Selection background highlight — review separately if a `ThemeBg` token (`selectedBg`) applies. |

All remaining raw ANSI uses are control sequences (cursor movement, line editing),
not display styling, and are documented as such in the `SEQ` constant comment block.

---

## 5. Acceptance Criteria Checklist

- [ ] `getModeLabelAnsi()` is removed; a renamed equivalent uses `theme.fg()`
      and `theme.bold()` with no hardcoded `\x1b[...m` escape sequences
- [ ] NORMAL label uses `theme.bold(theme.fg("accent", label))`
- [ ] SELECT label uses `theme.bold(theme.fg("warning", label))`
- [ ] INSERT label uses `theme.fg("muted", label)`
- [ ] `HelixEditor` constructor accepts `getTheme: () => Theme` as 3rd parameter
- [ ] `index.ts` factory passes `() => ctx.ui.theme` as the getter
- [ ] Mode label tracks theme changes within a session (getter thunk, not snapshot)
- [ ] `import type { Theme } from "@earendil-works/pi-coding-agent"` added to `editor.ts`
- [ ] No raw ANSI (`\x1b[` followed by color codes) remains in `getModeLabel*` path
- [ ] `SEQ` cursor-control constants are left unchanged (justified non-styling ANSI)
- [ ] Old comment `"Use raw ANSI since we don't have direct theme access here"` is removed
- [ ] TypeScript compiles without errors (`tsc --noEmit` or equivalent)
