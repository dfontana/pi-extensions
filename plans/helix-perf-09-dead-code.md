# Task 9: `findWordStarts()` and `findWordEnds()` are dead code

**Severity:** Low  
**Frequency:** Maintenance cost  
**File:** `buffer.ts:51-73`

These functions scan the entire text and return all positions. They are **never called** anywhere in the extension — actual navigation uses the incremental `nextWordStart()`, `prevWordStart()`, `nextWordEnd()` variants. They can be removed entirely.
