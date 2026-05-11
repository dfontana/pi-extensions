# Task 4: `navigateMatch()` rescans entire text on every `n`/`N`

**Severity:** Medium  
**Frequency:** Every search navigation  
**File:** `editor.ts:369-399`

```typescript
private navigateMatch(direction: 1 | -1): void {
  // Always recompute matches from the current text
  const freshMatches = findMatches(text, this.search.pattern)...
```

The comment explains this handles edits, but in Normal/Select mode (where `n`/`N` operates), no edits occur between navigation presses. A dirty flag or text-identity check would avoid redundant full-text regex scans.

**Fix:** Cache matches and invalidate only when `getText()` identity/length changes.
