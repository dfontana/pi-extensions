import type { Usage } from "@earendil-works/pi-ai";

export interface CacheStats {
  hitRate?: number;
  hasActivity: boolean;
}

export function cacheStats(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): CacheStats {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    hitRate: promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined,
    hasActivity: usage.cacheRead > 0 || usage.cacheWrite > 0,
  };
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCacheStat(stats: CacheStats): string | undefined {
  return stats.hasActivity && stats.hitRate !== undefined
    ? `CH${stats.hitRate.toFixed(1)}%`
    : undefined;
}

export function formatCostStat(cost: number): string | undefined {
  return cost > 0 ? `$${cost.toFixed(3)}` : undefined;
}

export function formatContextStat(percent: number | null | undefined, contextWindow: number): string {
  const formattedPercent = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
  return `${formattedPercent}/${formatTokens(contextWindow)}`;
}
