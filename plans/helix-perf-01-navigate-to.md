# Task 1: `navigateTo()` — O(distance) synthetic key events

**Severity:** High  
**Frequency:** Every word/search/label jump  
**File:** `editor.ts:278-304`

This is the most significant performance issue. Every cursor jump (`w`, `b`, `e`, `gg`, `ge`, `gw` label jumps, `n`/`N` search navigation) emits **O(|lineDelta| + targetCol)** individual `super.handleInput()` calls. Jumping from line 20, col 60 back to line 0, col 0 emits ~100 synthetic key events, each likely triggering internal editor state updates.

```typescript
for (let i = 0; i < lineDelta; i++) {
  super.handleInput(SEQ.lineEnd);   // one event
  super.handleInput(SEQ.right);     // another event
}
super.handleInput(SEQ.lineStart);
for (let i = 0; i < targetCol; i++) super.handleInput(SEQ.right); // N events
```

**Impact:** Noticeable latency on long multi-line prompts for operations like `gg`, `ge`, `gw`, or search jumps.

**Fix:** Lobby for or shim a `setCursor()` API on `CustomEditor` to replace the synthetic-keypress loop.
