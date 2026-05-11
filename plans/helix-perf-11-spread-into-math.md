# Task 11: `applySelectionHighlight` uses spread-into-Math for min/max

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `label-overlay.ts:246-247`

```typescript
const colStart = Math.min(...rowSpans.map(s => s.colStart));
const colEnd = Math.max(...rowSpans.map(s => s.colEnd));
```

Creates two intermediate arrays and spreads them into function arguments.

**Fix:** Simple loop — clearer and avoids allocation:
```typescript
let colStart = Infinity, colEnd = -Infinity;
for (const s of rowSpans) {
  colStart = Math.min(colStart, s.colStart);
  colEnd = Math.max(colEnd, s.colEnd);
}
```
