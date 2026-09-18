import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
  canonicalModel,
  classifyModelRoute,
  inspectModel,
  modelTier,
  resolveModelQuery,
} from "../model-query/query.ts";

export const REVIEW_THINKING_LEVELS = ["medium", "high", "xhigh"] as const;
export type ReviewThinkingLevel = (typeof REVIEW_THINKING_LEVELS)[number];

export const REVIEW_INTELLIGENCE_PREFERENCES = ["higher", "same"] as const;
export type ReviewIntelligencePreference = (typeof REVIEW_INTELLIGENCE_PREFERENCES)[number];

/** Compatibility shape retained for consumers that imported the old helper. */
export interface RankedModel {
  model: Model<Api>;
  baseId: string;
  rank: number;
  aggregator: number;
  version: number[];
  releaseDate: number;
}

export interface ReviewModelSelection {
  selected: Model<Api>;
  thinking: ReviewThinkingLevel;
  reason: string;
}

export interface SelectReviewModelInput {
  current: Model<Api> | undefined;
  available: Model<Api>[];
  thinking: ReviewThinkingLevel;
  intelligencePreference?: ReviewIntelligencePreference;
  minimumContextWindow?: number;
}

/** Canonical provider/model identity, shared with the general resolver. */
export { canonicalModel };

/**
 * Compatibility adapter for the former reviewer ranking helper. Selection
 * itself is delegated to model-query; this exposes only its model metadata.
 */
export function rankModel(model: Model<Api>): RankedModel | undefined {
  const metadata = inspectModel(model);
  if (metadata.rank === undefined) return undefined;
  return {
    model,
    baseId: metadata.baseId,
    rank: metadata.rank,
    aggregator: classifyModelRoute(model.provider) === "aggregator" ? 1 : 0,
    version: metadata.version,
    releaseDate: metadata.releaseDate,
  };
}

function selectedModel(canonical: string, available: readonly Model<Api>[]): Model<Api> {
  const match = available.find((model) => canonicalModel(model).toLowerCase() === canonical.toLowerCase());
  if (!match) throw new Error(`Resolved review model "${canonical}" disappeared from the registry snapshot.`);
  return match;
}

// Review policy: never select above the Opus/Sol ("sol") intelligence tier —
// rank 4 in model-query's TIER_RULES. Higher tiers such as Astra are excluded
// from review selection, and a session model above the cap is clamped down to
// the best capped tier.
const REVIEW_TIER_CAP = 4;

export function selectReviewModel(input: SelectReviewModelInput): ReviewModelSelection {
  const preference = input.intelligencePreference ?? "higher";
  if (!input.current) {
    throw new Error("No active session model is available; automatic review-model selection cannot compare intelligence tiers.");
  }
  const currentRank = modelTier(input.current);
  if (currentRank === undefined) {
    throw new Error(
      `${canonicalModel(input.current)} has an unrecognized intelligence tier; automatic review-model selection needs a recognized session model.`,
    );
  }

  // The cap is enforced by shaping the resolver inputs, not by changing the
  // resolver: candidates above the cap are removed, and a session model above
  // the cap uses the resolver's "lower" policy, whose preferred group is
  // exactly the best capped tier (rank below current, then equal).
  const cappedAvailable = input.available.filter((model) => {
    const rank = modelTier(model);
    return rank === undefined || rank <= REVIEW_TIER_CAP;
  });
  const clamped = currentRank > REVIEW_TIER_CAP;

  let result;
  try {
    result = resolveModelQuery({
      current: input.current,
      available: cappedAvailable,
      intelligence: clamped ? "lower" : preference,
      thinking: input.thinking,
      minimumContextWindow: input.minimumContextWindow,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No eligible model")) {
      throw new Error(
        `No eligible review model supports thinking=${input.thinking} ${
          clamped
            ? "at or below the sol review tier cap"
            : `at ${preference === "same" ? "the same" : "the same or a higher"} intelligence tier`
        }.`,
      );
    }
    throw error;
  }

  const selected = selectedModel(result.model, input.available);
  const selectedRank = modelTier(selected);
  const selectedBase = inspectModel(selected).baseId;
  const currentBase = inspectModel(input.current).baseId;

  const reason =
    clamped
      ? "Clamped to the sol review tier; selected the highest eligible model."
      : selectedRank !== undefined && selectedRank > currentRank
        ? "Selected a higher-ranked model."
        : selectedBase !== currentBase
          ? "Selected an equal-ranked peer."
          : !modelsAreEqual(selected, input.current)
            ? "Kept the current model via its preferred direct route."
            : "No higher-ranked model or peer was available; reused the current session model.";

  return { selected, thinking: input.thinking, reason };
}
