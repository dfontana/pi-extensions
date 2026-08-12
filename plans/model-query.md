# `model_query` design

**Status:** Design complete; implementation not started.

## Purpose

Create one general-purpose model resolver for extensions and agents. It will select
one usable model from Pi's live, authenticated model registry without inventing a
provider/model reference. The resolver owns model identity, tier ranking, creator
matching, route preference, thinking-level filtering, and deterministic
selection. Callers provide policy constraints; they do not reimplement ranking.

The public tool is named `model_query`.

## Decisions

- The result is always one best model, never a ranked list or a set of
  alternatives.
- Candidate models come only from `ctx.modelRegistry.getAvailable()` after a
  refresh. `getAll()` and synthetic/fallback models are not acceptable.
- Model references are exact canonical references (`provider/modelId`), exact
  registry IDs, or controlled short names. Matching is case-insensitive but not
  fuzzy: arbitrary phrases such as `"higher"` are not model names.
- Relative intelligence is a structured constraint (`higher` or `same`), not a
  model-name query. Its `higher` behavior is exactly the current reviewer
  behavior: prefer a higher tier, then an equal-tier peer, then the current
  model if necessary. `same` restricts candidates to the current tier and still
  prefers a distinct peer before reusing the current model.
- Intelligence tiers retain the current ID-only rules and ordering:
  `Opus/Sol > Sonnet/Terra > Luna > Mini/Haiku/Nano`. Display names are not
  used to infer intelligence.
- “Alternate creator” means model vendor/family, never the serving provider or
  route. A model served by OpenRouter, for example, may still have Anthropic as
  its creator when its model ID identifies Anthropic.
- Direct-route preference uses a code-owned, reviewed allowlist of known direct
  provider IDs. It is only a tie-breaker among active registry candidates; a
  direct provider that is not available cannot be selected.
- All Pi thinking levels are supported: `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, and `max`. A requested level filters candidates rather than
  causing an unsupported model to be silently downgraded.

## Architecture

```text
extensions/model-query/
  index.ts       # registers model_query; no selection policy outside query.ts
  query.ts       # pure resolver, identity/creator rules, ranking, errors
  README.md

review-model-selector/selector.ts
  thin review adapter around query.ts

subagent/index.ts
  resolves explicit model references through query.ts before spawning
```

`query.ts` must have no extension registration side effects. Both the reviewer
extension and the subagent extension import its pure functions. The registered
`model_query` tool is only one consumer of that library.

## Shared resolver contract

The central function will be equivalent to:

```ts
interface ModelQueryInput {
  available: readonly Model<Api>[];
  current?: Model<Api>;
  model?: string;                         // exact ID, canonical ref, or short name
  creator?: string;                        // model vendor, not provider
  intelligence?: "higher" | "same";       // relative to current
  thinking?: ModelThinkingLevel;
  minimumContextWindow?: number;
}

interface ModelQuerySelection {
  selected: Model<Api>;
  thinking?: ModelThinkingLevel;
  tier?: number;
  creator?: string;
  reason: string;
}
```

At least one useful selector (`model`, `creator`, or `intelligence`) is
required. `intelligence` requires `current`; a missing or unrecognized current
model is an error rather than an arbitrary fallback. A `model` reference may be
combined with `creator` and capability constraints, but the model reference is
never interpreted as natural language.

The tool returns the canonical `${provider}/${id}` for `selected`, plus the
requested thinking level and concise metadata/reason. It never returns
unavailable candidates. Errors explain whether identity, creator, capability,
context, or intelligence constraints produced an empty set.

### Identity and short names

Resolution is deliberately narrower than Pi's CLI fuzzy resolver:

1. Exact canonical provider/model reference.
2. Exact raw registry model ID.
3. Exact controlled aliases:
   - the final model-ID segment (`gpt-5.6-sol` for a routed
     `openai/gpt-5.6-sol` ID);
   - a recognized tier token such as `sol`;
   - any explicitly declared creator/family alias.
4. If several active routes match a short name, select one using the normal
   deterministic comparator below. No substring matching, display-name
   guessing, custom-model construction, or provider inference is allowed.

Exact canonical references remain the escape hatch for intentionally selecting
a particular route. A short name such as `sol` is therefore useful, while a
phrase such as `higher` fails identity resolution unless it is supplied as the
separate `intelligence` enum.

### Creator identity

Creator detection is a separate, data-driven mapping from model IDs to vendor
names. Namespaced IDs use a recognized vendor namespace when present; direct IDs
use known model-family prefixes. The serving `provider` field is never itself
used as the creator. Unknown creator identity is retained as unknown and cannot
satisfy an explicit `creator` filter, but it may still be resolved by an exact
model reference without a creator/intelligence constraint.

Creator aliases and family rules must be centralized and tested. They should
cover the vendors represented by the Pi catalog (for example Anthropic/Claude,
OpenAI/GPT, Google/Gemini, xAI/Grok, Mistral, Meta/Llama, Qwen, DeepSeek,
Moonshot/Kimi, MiniMax, Zai/GLM, and NVIDIA/Nemotron) without treating an
aggregator name as a creator. Adding a vendor is a data change, not a new
selection algorithm.

### Candidate eligibility

Before ranking, the resolver:

1. starts with the supplied active registry snapshot;
2. applies exact/short-name and creator filters;
3. excludes models that do not support the requested thinking level;
4. excludes models below `minimumContextWindow`;
5. applies the intelligence constraint, excluding unrecognized tiers for
   relative selection.

An exact, non-relative model lookup may resolve an unknown-tier active model;
relative intelligence selection may not guess its tier.

### Deterministic ranking

The comparator is shared by every caller. In order:

1. requested intelligence tier (higher rank first when selecting a best model);
2. known direct provider before a non-direct registered route;
3. for relative selection, a distinct model base ID before the current model's
   base ID (reviewer diversity);
4. newer version/release date when comparing models from the same provider and
   creator/family;
5. larger context window;
6. canonical `provider/id`, lexicographically.

The direct-provider allowlist is explicit and versioned in `query.ts`; unknown
providers are valid registry routes but rank after known direct providers.
Provider preference never overrides availability or an exact canonical request.
Every tie-breaker is pure and covered by tests, so registry enumeration order
cannot change the result.

## `model_query` tool

`index.ts` refreshes the registry once per call, obtains `getAvailable()`, and
passes the snapshot plus `ctx.model` to `query.ts`. Its schema exposes:

- optional exact/short `model`;
- optional model-vendor `creator`;
- optional `intelligence: "higher" | "same"`;
- optional all-level `thinking`;
- optional positive `minimumContextWindow`.

The description must explicitly teach that `model` accepts exact/canonical IDs
and controlled short names only, while `higher` belongs in `intelligence`.
The JSON result contains a single canonical `model` and no alternatives.

## Reviewer integration

`select_review_model` remains the public reviewer-facing tool and keeps its
existing `higher|same`, `medium|high|xhigh`, and context-window interface. Its
implementation becomes an adapter:

- refresh and collect the active registry as today;
- pass `ctx.model`, available models, the requested review thinking level, and
  the reviewer intelligence preference to `query.ts`;
- map the shared selection to the existing reviewer result shape.

The reviewer adapter owns only review-specific validation and output wording.
It must not retain a second tier table, creator detector, route comparator, or
model resolver. Existing exported helper names can be preserved as compatibility
aliases/re-exports while their implementation lives in `query.ts`.

## Subagent integration

The `subagent` tool resolves every explicit model reference before starting a
child:

- `task.model` overrides agent frontmatter, which overrides the parent model,
  preserving current precedence;
- explicit values are passed through the shared resolver, so short names such
  as `sol` become an active canonical provider/model reference;
- parent model defaults are already active, but are normalized to their
  canonical reference;
- optional model-reference thinking suffix compatibility is normalized by the
  shared resolver, with explicit `task.thinking` retaining precedence;
- the effective thinking level is checked against the selected model when one
  is known;
- an invalid, unauthenticated, unavailable, or ambiguous reference fails
  before any single task or parallel batch starts;
- the child receives the resolved canonical model, never an invented provider
  or unresolved short name.

A subagent model value is never interpreted as `higher`; relative intelligence
selection belongs to callers that explicitly supply the `intelligence`
constraint (not to agent frontmatter/model strings).

## Tests and documentation

1. Move the current tier, version, context, direct-route, diversity, and error
   cases into shared `model-query` unit tests.
2. Add coverage for canonical IDs, raw IDs, `sol`-style aliases, case folding,
   non-fuzzy rejection, deterministic ambiguous routes, creator-vs-provider
   behavior, unavailable direct routes, all seven thinking levels, and exact
   unknown-tier models.
3. Keep reviewer adapter tests proving its public contract and exact
   higher/same fallback semantics.
4. Extend subagent tests to prove short-name resolution, canonical child
   requests, thinking precedence, and all-or-nothing validation for parallel
   calls.
5. Add the new extension README and update the root extension table; update
   reviewer/subagent documentation to describe the shared resolver and the
   exact/short-name contract.
6. Run `npm test` and `npm run typecheck` after implementation.

## Non-goals

- Natural-language model recommendations or parsing phrases such as “best
  model” or “higher” as model names.
- Returning alternatives or exposing the full registry through the tool.
- Creating custom `Model` objects when a requested ID is absent.
- Treating provider routes as model creators.
- Cost optimization, latency measurement, or live provider health probing.
- Replacing Pi's general CLI model resolver; this resolver intentionally has a
  stricter no-fabrication contract for extension/subagent use.
