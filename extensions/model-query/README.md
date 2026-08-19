# model-query

Provides the `model_query` tool for resolving one usable model from Pi's authenticated model registry.

```jsonc
{
  "model": "sonnet",             // canonical provider/modelId or fuzzy short name
  "intelligence": "higher",      // "higher" | "same" | "lower"
  "excludeCurrentVendor": false,
  "thinking": "high",             // off | minimal | low | medium | high | xhigh | max
  "minimumContextWindow": 200000
}
```

All fields are policy. The tool refreshes Pi's registry and obtains the active model and authenticated
available-model snapshot from its extension context; callers cannot provide or override that runtime state.
It returns only:

```json
{ "model": "provider/modelId", "thinking": "high" }
```

Canonical references and exact registry IDs resolve directly. Other names use Pi's fuzzy model search
against provider/model IDs, never display-name recommendations or synthetic models. Every selected model
must be available, support the requested thinking level, and meet the requested context window.

`higher` requires a recognized active tier and prefers a higher tier, then an equal-tier peer, then the
active model. `same` stays at the active tier and prefers a distinct base model before reusing the active
base. `lower` requires a recognized active tier and prefers a lower tier, then an equal-tier peer, then the
active model; it never selects a higher tier. Tiers are inferred from IDs only: Opus/Sol > Sonnet/Terra >
Luna > Mini/Haiku/Nano. Direct native or
subscription routes always beat known aggregators regardless of tier; version/release date, context window, and canonical ID provide
stable tie-breakers. `excludeCurrentVendor` infers vendors from model IDs (Claude/Anthropic, GPT/OpenAI,
Gemini/Google, and Llama/Meta); unknown active vendors fail safely rather than guessing.

The resolver implementation in [`query.ts`](./query.ts) is pure and is shared by the review-model selector
and explicit model values in the subagent extension.
