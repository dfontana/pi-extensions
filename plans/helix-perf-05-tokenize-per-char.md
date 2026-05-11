# Task 5: `tokenize()` allocates one object per character

**Severity:** Medium  
**Frequency:** Every render with selection  
**File:** `label-overlay.ts:108-125`

```typescript
for (let i = lastIndex; i < match.index; i++) {
  tokens.push({ type: "char", raw: line[i]! });
}
```

For an 80-char line, this creates ~80 heap-allocated `{type, raw}` objects. In select mode, this runs for **every rendered line with a selection span**, on **every render frame**.

**Fix:** A single-pass highlight that walks the string and emits directly to an output buffer (no intermediate token array) would eliminate this allocation.
