# review-model-selector

Provides `select_review_model`, a reviewer-facing adapter around the shared [`model-query`](../model-query/README.md)
resolver. It refreshes Pi's authenticated model registry and selects one deterministic reviewer relative to the
active session model.

```jsonc
{
  "intelligence": "higher",        // "higher" | "same", default "higher"
  "thinking": "high",              // medium | high | xhigh, default "high"
  "minimumContextWindow": 200000   // integer ≥ 1, optional
}
```

The adapter preserves its existing reviewer validation and compatibility output, while model identity, tier
ranking, direct-route preference, diversity, capability filtering, and deterministic tie-breaks live in
`extensions/model-query/query.ts`. It never accepts caller-supplied current/available models or vendor values.
