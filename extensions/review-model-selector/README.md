# review-model-selector

Deterministically selects an adversarial code-review model relative to the active session model, from pi's available model registry. Used by the `run-review` skill, but callable by any workflow that needs a reviewer picked without hand-waving.

## Configuration

None. All inputs are tool parameters:

```jsonc
{
  "intelligence": "higher",        // "higher" | "same", default "higher"
  "thinking": "high",              // "medium" | "high" | "xhigh", default "high"
  "minimumContextWindow": 200000   // integer ≥ 1, optional — no default
}
```

## Provides

- `select_review_model` tool — returns JSON with `currentModel`/`currentTier`, `selectedModel`/`selectedTier`, `selectedContextWindow`, `thinking`, `intelligencePreference`, `escalated`, `reason`, optional `notice`, and the excluded-model lists (`excludedUnknownModels`, `excludedForThinking`).

### Selection algorithm

1. Every available model is ranked by a model-ID heuristic: Opus/Sol (400) > Sonnet/Terra (300) > Luna (200) > Mini/Haiku/Nano (100). IDs matching no tier are excluded and reported (`excludedUnknownModels`); display names are deliberately ignored (they carry unrelated branding).
2. Models not supporting the requested `thinking` level are excluded (`excludedForThinking`), as are models below `minimumContextWindow`.
3. With `intelligence: "higher"` (default): prefer any higher-ranked model, then an equal-ranked peer that isn't the current model, then the current model itself. With `"same"`: peers only, then the current model.
4. Within a group, candidates are ordered by rank, then (same provider + tier only) version and release date parsed from the model ID, then context window, then canonical name — fully deterministic.

## Limitations and Technical details

- Errors rather than guessing: no active session model, a session model with an unrecognized tier, or an empty eligible set all throw with an explanatory message. Lower-ranked fallbacks are never selected.
- `escalated: true` in the output means a higher tier than the session model was chosen; a `notice` is set when `"higher"` was requested but only a peer/current model was available.
- Version parsing understands `gpt-N.M` and `claude-{opus,sonnet,haiku}-N[-M][-YYYYMMDD]` ID shapes; other IDs compare as version 0 within their tier.
