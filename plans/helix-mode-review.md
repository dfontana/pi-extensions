# Helix Mode Review Checklist

This review is for the implementation in `jj diff -r rnx` against `plans/helix-mode.md`.

The original review had 11 findings, but the `/` search binding finding is intentionally omitted here because that plan item is outdated. The remaining feedback is ordered to minimize churn: first protect the agent harness and plugin ecosystem, then establish stable shared models, then repair feature behavior, then clean up presentation/docs/state.

## Recommended Fix Order

1. Fix harness/plugin compatibility first so later changes happen in the right integration shape.
2. Fix compile/API hazards before deeper refactors.
3. Introduce shared selection/search/navigation abstractions before changing individual commands.
4. Rework layout-dependent rendering after navigation/selection state is stable.
5. Apply UI polish and repository hygiene last.

---

## 7. Replace fragile synthetic-key cursor navigation with a safer abstraction

- **Priority:** High
- **Depends on:** Item 4
- **Files:** `extensions/helix-mode/editor.ts`; possibly requires Pi API changes or a local navigation adapter
- **Problem:** `navigateTo()` emits repeated Up/Down, line-start, and Right key sequences. Pi's editor movement is visual-line/history-aware, so wrapped lines, prompt history, and scrolling can make this land in the wrong logical position.
- **Context:** Many features depend on `navigateTo()`: search, `gg`/`ge`, `gw`, delete/change cursor restoration, line operations. Bugs in this helper will multiply as features are added.
- **Acceptance criteria:**
  - Provide a single navigation abstraction that has documented logical-line/column semantics.
  - Avoid using Up/Down visual movement for logical line targeting where possible.
  - If direct cursor-setting APIs do not exist, isolate the synthetic-key fallback behind one adapter with tests/known limitations.
  - Wrapped-line and multi-line prompt cases are manually verified.

## 8. Rework label and selection overlay layout to match Pi's editor

- **Priority:** Medium-High
- **Depends on:** Item 7
- **Files:** `extensions/helix-mode/label-overlay.ts`, `extensions/helix-mode/buffer.ts`, `extensions/helix-mode/editor.ts`
- **Problem:** Overlay layout reimplements word wrapping locally and uses an incorrect content width calculation. It does not account for Pi editor scroll offset, wide graphemes, paste markers, or the editor's exact layout width.
- **Context:** Pi's editor uses its exported `wordWrapLine` and width logic based on padding and cursor reservation. The local `buffer.ts` `wordWrapLine()` will drift from real rendering.
- **Acceptance criteria:**
  - Use Pi's exported wrapping/layout utilities where possible instead of the local clone.
  - Match Pi's content/layout width calculation exactly.
  - Account for visible scroll offset or avoid drawing labels/highlights for non-visible rows.
  - `gw` labels and selection highlights align on wrapped lines and wide-character input.

## 9. Use theme colors instead of raw ANSI for mode labels

- **Priority:** Medium
- **Files:** `extensions/helix-mode/editor.ts`
- **Problem:** `getModeLabelAnsi()` hardcodes raw cyan/yellow/dim ANSI sequences, bypassing the active theme.
- **Context:** The plan calls for theme-aware colors (`accent`, `dim`, `warning`). Hardcoded colors can clash with themes and other UI plugins.
- **Acceptance criteria:**
  - Store/use the provided theme or `ctx.ui.theme`-compatible styling for labels.
  - Normal/Insert/Select labels respect active theme colors.
  - Raw ANSI is only used where no theme abstraction exists and is documented.
