# Task 7: `selectionStart()` / `selectionEnd()` convert to offsets unnecessarily

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `selection.ts:70-90`

These functions call `lineColToOffset` twice to determine which endpoint is "earlier", but a simple tuple comparison `(line, col)` suffices:

```typescript
// Could be:
return (a.line < b.line || (a.line === b.line && a.col <= b.col)) ? a : b;
```

No offset computation needed.
