import { getSupportedThinkingLevels, modelsAreEqual, type Api, type Model } from "@earendil-works/pi-ai";

export const REVIEW_THINKING_LEVELS = ["medium", "high", "xhigh"] as const;
export type ReviewThinkingLevel = (typeof REVIEW_THINKING_LEVELS)[number];

export const REVIEW_INTELLIGENCE_PREFERENCES = ["higher", "same"] as const;
export type ReviewIntelligencePreference = (typeof REVIEW_INTELLIGENCE_PREFERENCES)[number];

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

// Tiers are inferred from model IDs only; display names can carry unrelated
// branding (for example "Nano Banana Pro" for an image model).
const TIER_RULES: ReadonlyArray<{ pattern: RegExp; rank: number }> = [
  { pattern: /(?:^|[^a-z])(opus|sol)(?:[^a-z]|$)/i, rank: 4 },
  { pattern: /(?:^|[^a-z])(sonnet|terra)(?:[^a-z]|$)/i, rank: 3 },
  { pattern: /(?:^|[^a-z])luna(?:[^a-z]|$)/i, rank: 2 },
  { pattern: /(?:^|[^a-z])(mini|haiku|nano)(?:[^a-z]|$)/i, rank: 1 },
];

export function canonicalModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function rankModel(model: Model<Api>): RankedModel | undefined {
  const rule = TIER_RULES.find(({ pattern }) => pattern.test(model.id));
  if (!rule) return undefined;

  // Aggregators namespace ids by vendor ("openai/gpt-5.6-sol") while direct
  // providers use the bare model name; the last segment identifies the model
  // across routes, and a namespaced id marks a deprioritized aggregator route.
  const segments = model.id.toLowerCase().split("/");
  const baseId = segments[segments.length - 1];

  // Numeric tokens in the base id are the version, except an 8-digit token,
  // which is a YYYYMMDD release date (so "claude-opus-4-20250514" reads as
  // version 4.0, not 4.20250514).
  const version: number[] = [];
  let releaseDate = 0;
  for (const token of baseId.match(/\d+/g) ?? []) {
    if (token.length === 8) releaseDate = Number(token);
    else version.push(Number(token));
  }

  return { model, baseId, rank: rule.rank, aggregator: segments.length - 1, version, releaseDate };
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectReviewModel(input: SelectReviewModelInput): ReviewModelSelection {
  const { current, available, thinking } = input;
  const preference = input.intelligencePreference ?? "higher";

  if (!current) {
    throw new Error("No active session model is available; automatic review-model selection cannot compare intelligence tiers.");
  }
  const currentRanked = rankModel(current);
  if (!currentRanked) {
    throw new Error(
      `${canonicalModel(current)} has an unrecognized intelligence tier; automatic review-model selection needs a recognized session model.`,
    );
  }

  // Preference order: highest tier, then direct routes over aggregators (a
  // native subscription must not be shadowed by a metered aggregator), then
  // distinct peers over the current model (reviewer diversity), then newest
  // version (only comparable within one vendor), then largest context.
  const compare = (a: RankedModel, b: RankedModel): number =>
    b.rank - a.rank ||
    a.aggregator - b.aggregator ||
    Number(a.baseId === currentRanked.baseId) - Number(b.baseId === currentRanked.baseId) ||
    (a.model.provider === b.model.provider
      ? compareVersions(a.version, b.version) || b.releaseDate - a.releaseDate
      : 0) ||
    b.model.contextWindow - a.model.contextWindow ||
    canonicalModel(a.model).localeCompare(canonicalModel(b.model));

  let selected: RankedModel | undefined;
  for (const model of available) {
    const candidate = rankModel(model);
    if (!candidate) continue;
    if (!getSupportedThinkingLevels(model).includes(thinking)) continue;
    if (model.contextWindow < (input.minimumContextWindow ?? 0)) continue;
    if (preference === "same" ? candidate.rank !== currentRanked.rank : candidate.rank < currentRanked.rank) continue;
    if (!selected || compare(candidate, selected) < 0) selected = candidate;
  }

  if (!selected) {
    throw new Error(
      `No eligible review model supports thinking=${thinking} at ${preference === "same" ? "the same" : "the same or a higher"} intelligence tier.`,
    );
  }

  const reason =
    selected.rank > currentRanked.rank
      ? "Selected a higher-ranked model."
      : selected.baseId !== currentRanked.baseId
        ? "Selected an equal-ranked peer."
        : !modelsAreEqual(selected.model, current)
          ? "Kept the current model via its preferred direct route."
          : "No higher-ranked model or peer was available; reused the current session model.";

  return { selected: selected.model, thinking, reason };
}
