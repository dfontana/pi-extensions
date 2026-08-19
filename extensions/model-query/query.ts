import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { fuzzyMatch } from "@earendil-works/pi-tui";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_SUFFIX = new RegExp(`:(${MODEL_THINKING_LEVELS.join("|")})$`, "i");

export function thinkingFromModelReference(reference: string | undefined): ModelThinkingLevel | undefined {
  const suffix = reference?.match(THINKING_SUFFIX)?.[1];
  return suffix?.toLowerCase() as ModelThinkingLevel | undefined;
}

export type ModelIntelligence = "higher" | "same" | "lower";

export interface ModelQueryOptions {
  /** A canonical provider/id reference or a short name searched with Pi's fuzzy matcher. */
  model?: string;
  /** Relative intelligence policy, evaluated against the active model. */
  intelligence?: ModelIntelligence;
  /** Remove candidates in the active model's inferred vendor family. */
  excludeCurrentVendor?: boolean;
  /** Require this exact thinking level; it is never silently downgraded. */
  thinking?: ModelThinkingLevel;
  /** Require at least this many context-window tokens. */
  minimumContextWindow?: number;
}

export interface ModelQueryResult {
  model: string;
  thinking?: ModelThinkingLevel;
}

/** Runtime state kept out of the public tool schema. */
export interface ModelQuerySnapshot {
  current?: Model<Api>;
  available: readonly Model<Api>[];
}

export interface ResolveModelQueryInput extends ModelQuerySnapshot, ModelQueryOptions {}

export type ModelVendor =
  | "anthropic"
  | "openai"
  | "google"
  | "meta"
  | "xai"
  | "mistral"
  | "qwen"
  | "deepseek"
  | "moonshot"
  | "minimax"
  | "zai"
  | "nvidia"
  | "cohere";
export type ModelRouteClass = "direct" | "unknown" | "aggregator";

interface TierRule {
  pattern: RegExp;
  rank: number;
}

export interface ModelMetadata {
  rank: number | undefined;
  baseId: string;
  route: string;
  vendor: ModelVendor | undefined;
  family: string;
  version: number[];
  releaseDate: number;
  routeClass: ModelRouteClass;
}

interface ModelCandidate extends ModelMetadata {
  model: Model<Api>;
  group: number;
}

// Intelligence is intentionally an ID-only policy. Display names are not
// stable enough to establish a model's capability tier.
const TIER_RULES: readonly TierRule[] = [
  { pattern: /(?:^|[^a-z])(opus|sol)(?:[^a-z]|$)/i, rank: 4 },
  { pattern: /(?:^|[^a-z])(sonnet|terra)(?:[^a-z]|$)/i, rank: 3 },
  { pattern: /(?:^|[^a-z])luna(?:[^a-z]|$)/i, rank: 2 },
  { pattern: /(?:^|[^a-z])(mini|haiku|nano)(?:[^a-z]|$)/i, rank: 1 },
];

// Provider is the serving route, not the model vendor. Keep these lists
// explicit so adding a provider is a deliberate policy decision rather than a
// guess based on a provider's name or the model ID namespace.
const DIRECT_ROUTE_PROVIDERS = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cloudflare-workers-ai",
  "deepseek",
  "google",
  "google-vertex",
  "github-copilot",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "openai",
  "openai-codex",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

const AGGREGATOR_ROUTE_PROVIDERS = new Set([
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "fireworks",
  "groq",
  "huggingface",
  "nvidia",
  "openrouter",
  "opencode",
  "opencode-go",
  "radius",
  "together",
  "vercel-ai-gateway",
]);

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function canonicalModel(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function modelTier(modelOrId: Model<Api> | string): number | undefined {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  return TIER_RULES.find(({ pattern }) => pattern.test(id))?.rank;
}

export function detectModelVendor(modelOrId: Model<Api> | string): ModelVendor | undefined {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const value = normalized(id);

  // Match model IDs, including IDs namespaced by an aggregator. Never inspect
  // the serving provider here: openrouter/claude-* is still an Anthropic model.
  if (/(?:^|[\/_:.-])(?:claude|anthropic)(?:$|[\/_:.-])/.test(value)) return "anthropic";
  if (/(?:^|[\/_:.-])(?:gpt|codex|o[1-9](?:-[a-z0-9]+)*)(?:$|[\/_:.-])/.test(value)) return "openai";
  if (/(?:^|[\/_:.-])(?:gemini|gemma|palm)(?:$|[\/_:.-])/.test(value)) return "google";
  if (/(?:^|[\/_:.-])(?:llama|meta-llama)(?:$|[\/_:.-])/.test(value)) return "meta";
  if (/(?:^|[\/_:.-])(?:grok|xai)(?:$|[\/_:.-])/.test(value)) return "xai";
  if (/(?:^|[\/_:.-])(?:mistral|mixtral|codestral|devstral)(?:$|[\/_:.-])/.test(value)) return "mistral";
  if (/(?:^|[\/_:.-])qwen(?:$|[\/_:.-])/.test(value)) return "qwen";
  if (/(?:^|[\/_:.-])deepseek(?:$|[\/_:.-])/.test(value)) return "deepseek";
  if (/(?:^|[\/_:.-])(?:kimi|moonshot)(?:$|[\/_:.-])/.test(value)) return "moonshot";
  if (/(?:^|[\/_:.-])minimax(?:$|[\/_:.-])/.test(value)) return "minimax";
  if (/(?:^|[\/_:.-])(?:glm|zai)(?:$|[\/_:.-])/.test(value)) return "zai";
  if (/(?:^|[\/_:.-])(?:nemotron|nvidia)(?:$|[\/_:.-])/.test(value)) return "nvidia";
  if (/(?:^|[\/_:.-])(?:command-r|cohere)(?:$|[\/_:.-])/.test(value)) return "cohere";
  return undefined;
}

export function classifyModelRoute(provider: string): ModelRouteClass {
  const id = normalized(provider);
  if (DIRECT_ROUTE_PROVIDERS.has(id)) return "direct";
  if (AGGREGATOR_ROUTE_PROVIDERS.has(id)) return "aggregator";
  // Unknown routes stay neutral. They are not promoted to direct or demoted
  // to aggregator based on a provider name; adding a route is a deliberate
  // data change to one of the maintained sets above.
  return "unknown";
}

function baseId(model: Model<Api>): string {
  const segments = model.id.toLowerCase().split("/");
  return segments[segments.length - 1] ?? model.id.toLowerCase();
}

function parseVersion(id: string): { version: number[]; releaseDate: number } {
  const version: number[] = [];
  let releaseDate = 0;
  for (const token of id.match(/\d+/g) ?? []) {
    if (token.length === 8) releaseDate = Number(token);
    else version.push(Number(token));
  }
  return { version, releaseDate };
}

function familyForBaseId(id: string): string {
  // Keep capability-family words (opus, sonnet, sol, etc.) while removing
  // version/date tokens. This prevents comparing versions across families.
  return id
    .split(/[-_.:]+/)
    .filter((token) => token && !/^v?\d+$/.test(token) && !/^\d{8}$/.test(token) && token !== "latest")
    .join("-");
}

export function inspectModel(model: Model<Api>): ModelMetadata {
  const base = baseId(model);
  const { version, releaseDate } = parseVersion(base);
  return {
    rank: modelTier(model),
    baseId: base,
    route: normalized(model.provider),
    vendor: detectModelVendor(model),
    family: familyForBaseId(base),
    version,
    releaseDate,
    routeClass: classifyModelRoute(model.provider),
  };
}

function candidateFor(model: Model<Api>, group: number): ModelCandidate {
  return { model, ...inspectModel(model), group };
}

function compareNumbersDescending(a: number, b: number): number {
  return b - a;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = compareNumbersDescending(a[index] ?? 0, b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function routeRank(route: ModelRouteClass): number {
  if (route === "direct") return 0;
  if (route === "unknown") return 1;
  return 2;
}

function sameFamilyAndRoute(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.vendor !== undefined && a.vendor === b.vendor && a.family === b.family && a.route === b.route;
}

/**
 * The one comparator shared by model-query consumers. Lower values sort first.
 * Registry enumeration order is deliberately never consulted.
 */
function compareModelCandidates(
  a: ModelCandidate,
  b: ModelCandidate,
  activeBaseId?: string,
  compareIntelligence = false,
): number {
  return (
    routeRank(a.routeClass) - routeRank(b.routeClass) ||
    a.group - b.group ||
    (compareIntelligence ? compareNumbersDescending(a.rank ?? -1, b.rank ?? -1) : 0) ||
    (activeBaseId !== undefined
      ? Number(a.baseId === activeBaseId) - Number(b.baseId === activeBaseId)
      : 0) ||
    (sameFamilyAndRoute(a, b) ? compareVersions(a.version, b.version) || b.releaseDate - a.releaseDate : 0) ||
    b.model.contextWindow - a.model.contextWindow ||
    (canonicalModel(a.model) < canonicalModel(b.model) ? -1 : canonicalModel(a.model) > canonicalModel(b.model) ? 1 : 0)
  );
}

function exactMatches(reference: string, available: readonly Model<Api>[]): Model<Api>[] | undefined {
  const value = normalized(reference);
  if (!value) return undefined;

  const canonical = available.filter((model) => normalized(canonicalModel(model)) === value);
  if (canonical.length) return canonical;

  const ids = available.filter((model) => normalized(model.id) === value);
  return ids.length ? ids : undefined;
}

function fuzzyScore(query: string, model: Model<Api>): number | undefined {
  // Keep identity constrained to the same provider/id search surface. Display
  // names are presentation metadata and must not become recommendation aliases.
  const text = `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}`;
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
  if (!tokens.length) return undefined;

  let score = 0;
  for (const token of tokens) {
    const match = fuzzyMatch(token, text);
    if (!match.matches) return undefined;
    score += match.score;
  }
  return score;
}

function resolveIdentity(reference: string | undefined, available: readonly Model<Api>[]): Model<Api>[] {
  if (reference === undefined) return [...available];

  const exact = exactMatches(reference, available);
  if (exact) return exact;

  const matches = available
    .map((model) => ({ model, score: fuzzyScore(reference, model) }))
    .filter((item): item is { model: Model<Api>; score: number } => item.score !== undefined);
  if (!matches.length) {
    throw new Error(`Model "${reference}" is not available in the authenticated model registry.`);
  }

  const bestScore = Math.min(...matches.map(({ score }) => score));
  return matches.filter(({ score }) => score === bestScore).map(({ model }) => model);
}

function intelligenceGroup(
  candidate: ModelCandidate,
  intelligence: ModelIntelligence | undefined,
  currentRank: number | undefined,
): number {
  if (!intelligence) return 0;
  if (candidate.rank === undefined || currentRank === undefined) return 99;

  // Keep peer/current diversity after route preference. Directional policies
  // prefer their requested side, then fall back to equal-tier candidates. A
  // direct active route therefore remains preferable to a metered peer, while
  // two candidates on the same route still prefer the distinct base model.
  if (intelligence === "same") return candidate.rank === currentRank ? 0 : 99;
  if (intelligence === "lower") {
    if (candidate.rank < currentRank) return 0;
    if (candidate.rank === currentRank) return 1;
    return 99;
  }
  if (candidate.rank > currentRank) return 0;
  if (candidate.rank === currentRank) return 1;
  return 99;
}

function describeEligibility(options: ModelQueryOptions): string {
  const requirements: string[] = [];
  if (options.thinking) requirements.push(`thinking=${options.thinking}`);
  if (options.minimumContextWindow !== undefined) requirements.push(`context>=${options.minimumContextWindow}`);
  if (options.excludeCurrentVendor) requirements.push("current-vendor exclusion");
  if (options.intelligence) requirements.push(`intelligence=${options.intelligence}`);
  return requirements.length ? requirements.join(", ") : "the requested policy";
}

function validateOptions(options: ModelQueryOptions): void {
  if (options.minimumContextWindow !== undefined && (!Number.isFinite(options.minimumContextWindow) || options.minimumContextWindow < 1)) {
    throw new Error("minimumContextWindow must be a finite number of at least 1.");
  }
}

/** Resolve one model from a private runtime snapshot. */
export function resolveModelQuery(input: ResolveModelQueryInput): ModelQueryResult {
  const { current, available, model, intelligence, excludeCurrentVendor = false, thinking, minimumContextWindow } = input;
  validateOptions(input);

  const currentRank = current ? modelTier(current) : undefined;
  const activeBase = current ? baseId(current) : undefined;

  if (intelligence && !current) {
    throw new Error(`intelligence=${intelligence} requires a recognized active model for relative selection.`);
  }
  if (intelligence && currentRank === undefined) {
    throw new Error(
      `${current ? canonicalModel(current) : "The active model"} has an unrecognized intelligence tier; relative model selection requires a recognized active model.`,
    );
  }

  const currentVendor = current ? detectModelVendor(current) : undefined;
  if (excludeCurrentVendor && !current) {
    throw new Error("excludeCurrentVendor requires an active model whose vendor can be inferred.");
  }
  if (excludeCurrentVendor && currentVendor === undefined) {
    throw new Error(
      `${current ? canonicalModel(current) : "The active model"} has an unknown vendor; it cannot be safely excluded.`,
    );
  }

  const identityMatches = resolveIdentity(model, available);
  const eligible: ModelCandidate[] = [];
  for (const candidateModel of identityMatches) {
    const vendor = detectModelVendor(candidateModel);
    if (excludeCurrentVendor && vendor !== undefined && vendor === currentVendor) continue;
    if (thinking && !getSupportedThinkingLevels(candidateModel).includes(thinking)) continue;
    if (minimumContextWindow !== undefined && candidateModel.contextWindow < minimumContextWindow) continue;

    const candidate = candidateFor(candidateModel, 0);
    const group = intelligenceGroup(candidate, intelligence, currentRank);
    if (group >= 99) continue;
    eligible.push({ ...candidate, group });
  }

  if (!eligible.length) {
    const requested = model ? ` for model "${model}"` : "";
    throw new Error(`No eligible model${requested} satisfies ${describeEligibility(input)}.`);
  }

  eligible.sort((a, b) => compareModelCandidates(a, b, intelligence ? activeBase : undefined, intelligence !== undefined));
  const selected = eligible[0];
  if (!selected) {
    throw new Error(`No eligible model satisfies ${describeEligibility(input)}.`);
  }

  return { model: canonicalModel(selected.model), ...(thinking === undefined ? {} : { thinking }) };
}

/** Explicit-reference adapter used by subagents, including Pi's `:thinking` suffix compatibility. */
export function resolveModelReference(
  reference: string,
  snapshot: ModelQuerySnapshot,
  thinking?: ModelThinkingLevel,
): ModelQueryResult {
  const fullExact = exactMatches(reference, snapshot.available);
  if (fullExact) return resolveModelQuery({ ...snapshot, model: reference, thinking });

  const suffix = thinkingFromModelReference(reference);
  if (suffix) {
    return resolveModelQuery({
      ...snapshot,
      model: reference.slice(0, -(suffix.length + 1)),
      thinking: thinking ?? suffix,
    });
  }
  return resolveModelQuery({ ...snapshot, model: reference, thinking });
}

