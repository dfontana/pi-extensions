import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

export const REVIEW_THINKING_LEVELS = ["medium", "high", "xhigh"] as const;
export type ReviewThinkingLevel = (typeof REVIEW_THINKING_LEVELS)[number];

export const REVIEW_INTELLIGENCE_PREFERENCES = ["higher", "same"] as const;
export type ReviewIntelligencePreference = (typeof REVIEW_INTELLIGENCE_PREFERENCES)[number];

export interface RankedModel {
  model: Model<Api>;
  canonical: string;
  rank: number;
  tier: string;
  version: number[];
  releaseDate: number;
}

export interface ReviewModelSelection {
  current?: RankedModel;
  selected: RankedModel;
  thinking: ReviewThinkingLevel;
  intelligencePreference: ReviewIntelligencePreference;
  escalated: boolean;
  reason: string;
  notice?: string;
  excludedUnknown: string[];
  excludedThinking: string[];
}

export interface SelectReviewModelInput {
  current: Model<Api> | undefined;
  available: Model<Api>[];
  thinking: ReviewThinkingLevel;
  intelligencePreference?: ReviewIntelligencePreference;
  minimumContextWindow?: number;
}

const TIER_RULES: ReadonlyArray<{ pattern: RegExp; rank: number; tier: string }> = [
  { pattern: /(?:^|[^a-z])(opus|sol)(?:[^a-z]|$)/i, rank: 400, tier: "opus/sol" },
  { pattern: /(?:^|[^a-z])(sonnet|terra)(?:[^a-z]|$)/i, rank: 300, tier: "sonnet/terra" },
  { pattern: /(?:^|[^a-z])luna(?:[^a-z]|$)/i, rank: 200, tier: "luna" },
  { pattern: /(?:^|[^a-z])(mini|haiku|nano)(?:[^a-z]|$)/i, rank: 100, tier: "mini/haiku/nano" },
];

export function canonicalModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function modelVersion(model: Model<Api>): { version: number[]; releaseDate: number } {
  const id = model.id.toLowerCase();
  const gpt = id.match(/gpt-(\d+)[.-](\d+)/);
  if (gpt) return { version: gpt.slice(1).map(Number), releaseDate: 0 };

  const claude = id.match(/claude-(?:opus|sonnet|haiku)-([0-9-]+)/);
  if (!claude) return { version: [], releaseDate: 0 };

  const parts = claude[1].split("-");
  const major = Number(parts[0]);
  const second = parts[1] ?? "";
  const hasMinor = /^\d{1,2}$/.test(second);
  const datePart = hasMinor ? parts[2] : second;
  return {
    version: [major, hasMinor ? Number(second) : 0],
    releaseDate: /^\d{8}$/.test(datePart) ? Number(datePart) : 0,
  };
}

export function rankModel(model: Model<Api>): RankedModel | undefined {
  // Display names can contain unrelated product branding (for example "Nano
  // Banana Pro" for an image model), so automatic intelligence inference is
  // intentionally restricted to model IDs.
  const rule = TIER_RULES.find(({ pattern }) => pattern.test(model.id));
  if (!rule) return undefined;

  const { version, releaseDate } = modelVersion(model);
  return {
    model,
    canonical: canonicalModel(model),
    rank: rule.rank,
    tier: rule.tier,
    version,
    releaseDate,
  };
}

function supportsThinking(model: Model<Api>, thinking: ReviewThinkingLevel): boolean {
  return getSupportedThinkingLevels(model).includes(thinking);
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareCandidates(a: RankedModel, b: RankedModel): number {
  const sameProviderAndTier = a.model.provider === b.model.provider && a.tier === b.tier;
  const versionDifference = sameProviderAndTier ? compareVersions(a.version, b.version) : 0;
  const releaseDifference = sameProviderAndTier ? b.releaseDate - a.releaseDate : 0;
  return (
    b.rank - a.rank ||
    versionDifference ||
    releaseDifference ||
    b.model.contextWindow - a.model.contextWindow ||
    a.canonical.localeCompare(b.canonical)
  );
}

export function selectReviewModel(input: SelectReviewModelInput): ReviewModelSelection {
  const { current, available, thinking } = input;
  const intelligencePreference = input.intelligencePreference ?? "higher";
  const currentRanked = current ? rankModel(current) : undefined;
  const excludedUnknown = available.filter((model) => !rankModel(model)).map(canonicalModel).sort();
  const excludedThinking = available
    .filter((model) => rankModel(model) && !supportsThinking(model, thinking))
    .map(canonicalModel)
    .sort();

  if (!current) {
    throw new Error("No active session model is available; automatic review-model selection cannot compare intelligence tiers.");
  }
  if (!currentRanked) {
    throw new Error(
      `${canonicalModel(current)} has an unrecognized intelligence tier. Automatic review-model selection requires a recognized tier; pass intelligence="same" or "higher" after confirming the session model.`,
    );
  }

  const eligible = available
    .map(rankModel)
    .filter((model): model is RankedModel => model !== undefined)
    .filter((model) => supportsThinking(model.model, thinking))
    .filter((model) => input.minimumContextWindow === undefined || model.model.contextWindow >= input.minimumContextWindow);

  const sameModel = (candidate: RankedModel) => candidate.canonical === currentRanked.canonical;

  const higherGroup = {
    reason: "Selected a higher-ranked model.",
    candidates: eligible.filter((candidate) => candidate.rank > currentRanked.rank),
  };

  const peerGroup = {
    reason: "Selected an equal-ranked peer.",
    candidates: eligible.filter(
      (candidate) => candidate.rank === currentRanked.rank && !sameModel(candidate),
    ),
  };

  const fallbackGroup = {
    reason: "No peer was available; reused the current session model.",
    candidates: eligible.filter(sameModel),
  };

  const groups = [
    ...(intelligencePreference === "higher" ? [higherGroup] : []),
    peerGroup,
    fallbackGroup,
  ];

  const group = groups.find(({ candidates }) => candidates.length > 0);
  if (!group) {
    const preferenceNote = intelligencePreference === "same" ? " within the same intelligence tier" : "";
    throw new Error(
      `No eligible review model supports thinking=${thinking}${preferenceNote}. Unknown model names and lower-ranked fallbacks are intentionally excluded.`,
    );
  }

  const selected = [...group.candidates].sort(compareCandidates)[0];
  const escalated = selected.rank > currentRanked.rank;
  return {
    current: currentRanked,
    selected,
    thinking,
    intelligencePreference,
    escalated,
    reason: group.reason,
    notice: intelligencePreference === "higher" && !escalated
      ? "Higher intelligence was not available; review will continue with a peer or the current model."
      : undefined,
    excludedUnknown,
    excludedThinking,
  };
}
