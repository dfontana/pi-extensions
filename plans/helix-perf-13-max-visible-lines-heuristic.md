# Task 13: `getMaxVisibleLines()` uses a fragile 30% heuristic

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `editor.ts:354-358`

```typescript
private getMaxVisibleLines(): number {
  const rows = this.tui.terminal.rows;
  return Math.max(5, Math.floor(rows * 0.3));
}
```

This guesses at the editor's actual visible height. If the editor exposes its actual content height (or if it's derivable from `super.render()` output minus borders), using the real value would be more robust and avoid over/under-computing label maps.
