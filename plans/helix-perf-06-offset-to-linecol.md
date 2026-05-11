# Task 6: `offsetToLineCol()` is O(n) linear scan

**Severity:** Low  
**Frequency:** Multiple times per operation  
**File:** `buffer.ts:27-38`

```typescript
for (let i = 0; i < clamped; i++) {
  if (text[i] === "\n") { line++; col = 0; } else { col++; }
}
```

Called multiple times per operation (e.g., `navigateMatch` calls it twice, `moveWord*` once each). For typical prompt sizes this is fine, but it's called redundantly when `getLines()` is already available — a simple prefix-sum over line lengths would be O(1) per lookup.

**Fix:** Add an `offsetToLineColFromLines(lines, offset)` that walks by line lengths instead of character-by-character.
