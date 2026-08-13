import type { Message, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import {
  cacheStats,
  formatCacheStat,
  formatContextStat,
  formatCostStat,
  formatTokens,
} from "../shared/usage-helpers.ts";

export interface TrackedUsage {
  usage: Usage;
  turns: number;
  contextTokens: number;
  /** Context window for the resolved model, when available. */
  contextWindow?: number;
  /** Cache-hit rate for the latest assistant request, or null when it had no prompt tokens. */
  latestCacheHitRate?: number | null;
  /** Whether any assistant request has reported cache activity. */
  hasCacheActivity?: boolean;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function emptyTrackedUsage(contextWindow?: number): TrackedUsage {
  const tracked: TrackedUsage = { usage: emptyUsage(), turns: 0, contextTokens: 0 };
  if (contextWindow !== undefined) tracked.contextWindow = contextWindow;
  return tracked;
}

function addUsage(target: Usage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;

  if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
}

export function trackMessageUsage(target: TrackedUsage, message: Message): void {
  if (message.role === "assistant") {
    target.turns++;
    const cache = cacheStats(message.usage);
    target.latestCacheHitRate = cache.hitRate ?? null;
    if (cache.hasActivity) target.hasCacheActivity = true;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      const contextTokens = calculateContextTokens(message.usage);
      if (contextTokens > 0) target.contextTokens = contextTokens;
    }
    addUsage(target.usage, message.usage);
  } else if (message.role === "toolResult" && message.usage) {
    addUsage(target.usage, message.usage);
  }
}

function formatTokenStats(usage: Usage): string[] {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  return parts;
}

export function formatUsage(usage: TrackedUsage): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  parts.push(...formatTokenStats(usage.usage));

  const cache = "latestCacheHitRate" in usage
    ? {
        hitRate: usage.latestCacheHitRate ?? undefined,
        hasActivity: usage.hasCacheActivity ?? cacheStats(usage.usage).hasActivity,
      }
    : cacheStats(usage.usage);
  const cacheStat = formatCacheStat(cache);
  if (cacheStat) parts.push(cacheStat);

  const costStat = formatCostStat(usage.usage.cost.total);
  if (costStat) parts.push(costStat);

  if (usage.contextWindow && usage.contextWindow > 0) {
    const percent = usage.contextTokens > 0
      ? (usage.contextTokens / usage.contextWindow) * 100
      : null;
    parts.push(formatContextStat(percent, usage.contextWindow));
  }
  return parts.join(" ");
}
