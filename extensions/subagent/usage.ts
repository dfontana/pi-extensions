import type { Message, Usage } from "@earendil-works/pi-ai";

export interface TrackedUsage {
  usage: Usage;
  turns: number;
  contextTokens: number;
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

export function emptyTrackedUsage(): TrackedUsage {
  return { usage: emptyUsage(), turns: 0, contextTokens: 0 };
}

export function addUsage(target: Usage, usage: Usage): void {
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
    target.contextTokens = message.usage.totalTokens;
    addUsage(target.usage, message.usage);
  } else if (message.role === "toolResult" && message.usage) {
    addUsage(target.usage, message.usage);
  }
}

export function aggregateUsage(items: readonly TrackedUsage[]): Usage {
  const total = emptyUsage();
  for (const item of items) addUsage(total, item.usage);
  return total;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: TrackedUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.usage.input) parts.push(`↑${formatTokens(usage.usage.input)}`);
  if (usage.usage.output) parts.push(`↓${formatTokens(usage.usage.output)}`);
  if (usage.usage.cacheRead) parts.push(`R${formatTokens(usage.usage.cacheRead)}`);
  if (usage.usage.cacheWrite) parts.push(`W${formatTokens(usage.usage.cacheWrite)}`);
  if (usage.usage.cost.total) parts.push(`$${usage.usage.cost.total.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatAggregateUsage(items: readonly TrackedUsage[]): string {
  const tracked = emptyTrackedUsage();
  for (const item of items) {
    tracked.turns += item.turns;
    addUsage(tracked.usage, item.usage);
  }
  return formatUsage(tracked);
}
