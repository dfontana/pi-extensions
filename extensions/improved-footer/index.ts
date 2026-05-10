/**
 * Improved Footer Extension
 *
 * Replaces pi's default footer with one that:
 * - Shows jj bookmark (jj:name) instead of git branch, with git fallback
 * - Uses OpenRouter's /api/v1/generation API for accurate cost tracking
 *   instead of pi's client-side estimation
 *
 * Footer layout mirrors pi's default exactly:
 *   Line 1: ~/cwd (jj:bookmark) • session-name
 *   Line 2: ↑tokens ↓tokens Rcache Wcache $cost ctx%/window (auto)  (provider) model • thinking
 *   Line 3: extension statuses
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// ─── VCS Detection ────────────────────────────────────────────────────────

function exec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getVcsInfo(cwd: string): string | null {
  const jjDir = join(cwd, ".jj");
  if (existsSync(jjDir)) {
    const result = exec("jj branch", cwd);
    if (result) {
      const bookmark = result.trim().split("\n")[0];
      if (bookmark) return `jj:${bookmark}`;
    }
    return "jj:??";
  }

  if (existsSync(join(cwd, ".git"))) {
    const branch = exec("git rev-parse --abbrev-ref HEAD", cwd);
    if (branch && branch !== "HEAD") return branch;
  }

  return null;
}

// ─── Token Formatting (mirrors pi's formatTokens) ──────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// ─── OpenRouter Cost Tracking ─────────────────────────────────────────────

interface CostState {
  /** OpenRouter API cost (more accurate than pi's estimate — fetched from /api/v1/generation) */
  orCost: number;
  /** pi's built-in cost for non-OpenRouter providers (accumulated from message_end events) */
  piCost: number;
  totalCacheDiscount: number;
  lastProvider: string;
  lastModel: string;
  /** Tracks OpenRouter gen-ids that have already been fetched */
  seenIds: Set<string>;
}

async function fetchGenerationCost(
  responseId: string,
  apiKey: string,
): Promise<{ totalCost: number; cacheDiscount: number; provider: string; model: string } | null> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${responseId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!data || typeof data.total_cost !== "number") return null;
    return {
      totalCost: data.total_cost ?? 0,
      cacheDiscount: data.cache_discount ?? 0,
      provider: data.provider_name ?? "",
      model: data.model ?? "",
    };
  } catch {
    return null;
  }
}

function getOpenRouterApiKey(ctx: ExtensionContext): string | null {
  try {
    const providers = (ctx.modelRegistry as any).getProviders?.() ?? [];
    for (const p of providers) {
      if (p.id === "openrouter" || p.name === "openrouter") {
        return p.apiKey ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let costState: CostState = {
    orCost: 0,
    piCost: 0,
    totalCacheDiscount: 0,
    lastProvider: "",
    lastModel: "",
    seenIds: new Set(),
  };

  let openRouterApiKey: string | null = null;
  let footerTui: { requestRender: () => void } | null = null;
  let modelId = "";
  let thinkingLevel = "off";
  let autoCompact = true;

  function requestRender() {
    footerTui?.requestRender();
  }

  // ─── Event: model changes ───────────────────────────────────────────────

  pi.on("model_select", async (event, _ctx) => {
    modelId = event.model.id;
    requestRender();
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    thinkingLevel = event.level;
    requestRender();
  });

  // ─── Event: track cost from responses (OpenRouter API or pi built-in) ───

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const provider = event.message.provider;

    if (provider === "openrouter") {
      // OpenRouter: use generation API for accurate provider-agnostic cost
      const responseId = event.message.responseId;
      if (!responseId || !responseId.startsWith("gen-")) return;
      if (costState.seenIds.has(responseId)) return;
      costState.seenIds.add(responseId);

      if (!openRouterApiKey) {
        openRouterApiKey = getOpenRouterApiKey(ctx);
      }
      if (!openRouterApiKey) return;

      const gen = await fetchGenerationCost(responseId, openRouterApiKey);
      if (!gen) return;

      costState.orCost += gen.totalCost;
      costState.totalCacheDiscount += gen.cacheDiscount;
      if (gen.provider) costState.lastProvider = gen.provider;
      if (gen.model) costState.lastModel = gen.model;
    } else {
      // Non-OpenRouter: use pi's built-in cost from usage
      costState.piCost += event.message.usage.cost.total;
      if (event.message.provider) costState.lastProvider = event.message.provider;
      if (event.message.model) costState.lastModel = event.message.model;
    }

    requestRender();
  });

  // ─── Session start: install custom footer ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Pre-populate cost from existing session entries on restore
    costState = { orCost: 0, piCost: 0, totalCacheDiscount: 0, lastProvider: "", lastModel: "", seenIds: new Set() };
    modelId = ctx.model?.id ?? "";

    ctx.ui.setFooter((tui, theme, _footerData) => {
      footerTui = tui;

      return {
        invalidate() {},
        dispose() {
          footerTui = null;
        },
        render(width: number): string[] {
          // ── Compute token totals from session ──
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          try {
            for (const entry of ctx.sessionManager.getEntries()) {
              if (entry.type === "message" && entry.message.role === "assistant") {
                totalInput += entry.message.usage.input;
                totalOutput += entry.message.usage.output;
                totalCacheRead += entry.message.usage.cacheRead;
                totalCacheWrite += entry.message.usage.cacheWrite;
              }
            }
          } catch { /* session may not be loaded yet */ }

          // ── Context usage ──
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null
            ? contextPercentValue.toFixed(1)
            : "?";

          // ── Line 1: CWD + VCS + session name ──
          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }
          const vcsInfo = getVcsInfo(ctx.cwd);
          if (vcsInfo) {
            pwd = `${pwd} (${vcsInfo})`;
          }
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: Token stats + cost + context % + right-aligned model ──
          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

          // Cost: combines OpenRouter API cost (more accurate) + pi's built-in cost
          const hasTrackedCosts = costState.orCost > 0 || costState.piCost > 0;
          if (hasTrackedCosts) {
            const combinedCost = costState.orCost + costState.piCost;
            statsParts.push(`$${combinedCost.toFixed(3)}`);
          } else {
            // Fallback on first render before any message_end events fire
            // (e.g. session restore). Uses pi's cost for all messages.
            let piCost = 0;
            try {
              for (const entry of ctx.sessionManager.getEntries()) {
                if (entry.type === "message" && entry.message.role === "assistant") {
                  piCost += entry.message.usage.cost.total;
                }
              }
            } catch { /* */ }
            if (piCost > 0) {
              statsParts.push(`$${piCost.toFixed(3)}`);
            }
          }

          // Context percentage with color
          const autoIndicator = autoCompact ? " (auto)" : "";
          const contextPercentDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

          let contextPercentStr: string;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          let statsLeft = statsParts.join(" ");

          // Model + thinking on the right
          const mId = modelId || ctx.model?.id || "no-model";
          let rightSide = mId;
          if (ctx.model?.reasoning) {
            const tl = thinkingLevel || "off";
            rightSide = tl === "off" ? `${mId} • thinking off` : `${mId} • ${tl}`;
          }

          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const minPadding = 2;
          const rightSideWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              const truncatedRightWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);
          const statsLine2 = dimStatsLeft + dimRemainder;

          const lines = [pwdLine, statsLine2];

          // ── Line 3: Extension statuses ──
          const extensionStatuses = _footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  });

  // ─── Cleanup ────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setFooter(undefined);
  });
}