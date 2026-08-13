import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  emptyTrackedUsage,
  emptyUsage,
  formatUsage,
  trackMessageUsage,
  type TrackedUsage,
} from "./usage.ts";

type UsageOverrides = Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };

function usage(overrides: UsageOverrides = {}): Usage {
  const empty = emptyUsage();
  return { ...empty, ...overrides, cost: { ...empty.cost, ...overrides.cost } };
}

function assistant(messageUsage: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: messageUsage,
    stopReason,
    timestamp: 0,
  };
}

describe("subagent usage", () => {
  it("matches the improved footer stats with turns as the only extra metric", () => {
    const tracked: TrackedUsage = {
      usage: usage({
        input: 1_234,
        output: 56_789,
        cacheRead: 600,
        cacheWrite: 400,
        totalTokens: 20_000,
        cost: { total: 1.23456 },
      }),
      turns: 2,
      contextTokens: 20_000,
      contextWindow: 100_000,
      latestCacheHitRate: 26.85,
      hasCacheActivity: true,
    };

    assert.equal(formatUsage(tracked), "2 turns ↑1.2k ↓57k CH26.9% $1.235 20.0%/100k");
  });

  it("does not fall back to stale cache stats when the latest request has no prompt tokens", () => {
    const tracked = emptyTrackedUsage(1_000);
    trackMessageUsage(tracked, assistant(usage({ input: 10, cacheRead: 90, totalTokens: 100 })));
    trackMessageUsage(tracked, assistant(usage({ output: 1, totalTokens: 100 })));

    assert.doesNotMatch(formatUsage(tracked), /CH/);
    const restored = JSON.parse(JSON.stringify(tracked)) as TrackedUsage;
    assert.doesNotMatch(formatUsage(restored), /CH/);
  });

  it("reuses Pi's context calculation and keeps the last valid response as the context anchor", () => {
    const tracked = emptyTrackedUsage(1_000);
    trackMessageUsage(tracked, assistant(usage({ input: 100, output: 20 })));
    trackMessageUsage(tracked, assistant(usage({ totalTokens: 900 }), "error"));
    trackMessageUsage(tracked, assistant(usage({ totalTokens: 800 }), "aborted"));

    assert.equal(tracked.contextTokens, 120);
    assert.match(formatUsage(tracked), /12\.0%\/1\.0k$/);
  });

});
