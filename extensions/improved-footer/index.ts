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
 *   Line 2: ↑tokens ↓tokens Rcache Wcache $cost ctx%/window  model • thinking
 *   Line 3: extension statuses
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// ─── Jujutsu Bookmark Detection (async, activity-triggered) ───────────────

function execAsync(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

async function resolveJjBookmark(cwd: string): Promise<string | null> {
  if (!existsSync(join(cwd, ".jj"))) return null;
  const result = await execAsync(
    "jj",
    ["log", "-r", "ancestors(@) & bookmarks()", "-T", "local_bookmarks.map(|c| c.name())", "-n", "1", "--no-graph"],
    cwd,
  );
  if (result) {
    const bookmark = result.trim().split("\n")[0];
    if (bookmark) return `jj:${bookmark}`;
  }
  return "jj:??";
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

  // ─── Cached token totals (updated incrementally on message_end) ─────────
  let cachedTotalInput = 0;
  let cachedTotalOutput = 0;
  let cachedTotalCacheRead = 0;
  let cachedTotalCacheWrite = 0;

  // ─── VCS state: jj bookmark (activity-triggered), git from FooterDataProvider ──
  let jjBookmark: string | null = null;
  let isJjRepo = false;
  let vcsCwd: string | null = null;

  function requestRender() {
    footerTui?.requestRender();
  }

  function refreshJjBookmark() {
    if (!isJjRepo || !vcsCwd) return;
    void resolveJjBookmark(vcsCwd).then((value) => {
      if (value !== jjBookmark) {
        jjBookmark = value;
        requestRender();
      }
    });
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

    // Incrementally accumulate token totals (avoids re-iterating all entries in render)
    cachedTotalInput += event.message.usage.input;
    cachedTotalOutput += event.message.usage.output;
    cachedTotalCacheRead += event.message.usage.cacheRead;
    cachedTotalCacheWrite += event.message.usage.cacheWrite;

    // Refresh jj bookmark on activity (cheap: only fires when user is interacting)
    refreshJjBookmark();

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
    // Reset state
    costState = { orCost: 0, piCost: 0, totalCacheDiscount: 0, lastProvider: "", lastModel: "", seenIds: new Set() };
    cachedTotalInput = 0;
    cachedTotalOutput = 0;
    cachedTotalCacheRead = 0;
    cachedTotalCacheWrite = 0;
    modelId = ctx.model?.id ?? "";
    vcsCwd = ctx.cwd;
    isJjRepo = existsSync(join(ctx.cwd, ".jj"));

    // Backfill token totals from existing session entries (session restore)
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          cachedTotalInput += entry.message.usage.input;
          cachedTotalOutput += entry.message.usage.output;
          cachedTotalCacheRead += entry.message.usage.cacheRead;
          cachedTotalCacheWrite += entry.message.usage.cacheWrite;
        }
      }
    } catch { /* session may not be loaded yet */ }

    // Fire initial jj bookmark lookup
    refreshJjBookmark();

    let unsubBranchChange: (() => void) | null = null;

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTui = tui;

      // Subscribe to git branch changes from FooterDataProvider (file-watcher based)
      unsubBranchChange = footerData.onBranchChange(() => requestRender());

      return {
        invalidate() {},
        dispose() {
          footerTui = null;
          unsubBranchChange?.();
          unsubBranchChange = null;
        },
        render(width: number): string[] {
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
          // jj repos: use our async bookmark; git repos: use FooterDataProvider's watcher
          const vcsInfo = isJjRepo ? jjBookmark : footerData.getGitBranch();
          if (vcsInfo) {
            pwd = `${pwd} (${vcsInfo})`;
          }
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: Token stats + cost + context % | right-aligned model ──
          const statsParts: string[] = [];
          if (cachedTotalInput) statsParts.push(`↑${formatTokens(cachedTotalInput)}`);
          if (cachedTotalOutput) statsParts.push(`↓${formatTokens(cachedTotalOutput)}`);
          if (cachedTotalCacheRead) statsParts.push(`R${formatTokens(cachedTotalCacheRead)}`);
          if (cachedTotalCacheWrite) statsParts.push(`W${formatTokens(cachedTotalCacheWrite)}`);

          const combinedCost = costState.orCost + costState.piCost;
          if (combinedCost > 0) {
            statsParts.push(`$${combinedCost.toFixed(3)}`);
          }

          // Context percentage with color
          const contextPercentDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}`
            : `${contextPercent}%/${formatTokens(contextWindow)}`;

          if (contextPercentValue > 90) {
            statsParts.push(theme.fg("error", contextPercentDisplay));
          } else if (contextPercentValue > 70) {
            statsParts.push(theme.fg("warning", contextPercentDisplay));
          } else {
            statsParts.push(contextPercentDisplay);
          }

          const statsLeft = statsParts.join(" ");

          // Model + thinking on the right
          const mId = modelId || ctx.model?.id || "no-model";
          let rightSide = mId;
          if (ctx.model?.reasoning) {
            const tl = thinkingLevel || "off";
            rightSide = tl === "off" ? `${mId} • thinking off` : `${mId} • ${tl}`;
          }

          const statsLine2 = theme.fg("dim", padBetween(statsLeft, rightSide, width));

          const lines = [pwdLine, statsLine2];

          // ── Line 3: Extension statuses ──
          const extensionStatuses = footerData.getExtensionStatuses();
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
    vcsCwd = null;
    isJjRepo = false;
    jjBookmark = null;
    ctx.ui.setFooter(undefined);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Lay out left-aligned and right-aligned text, truncating the right side if needed. */
function padBetween(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + 2 + rw <= width) {
    return left + " ".repeat(width - lw - rw) + right;
  }
  // Not enough room for both — show left, truncate right
  const available = width - lw - 2;
  if (available > 0) {
    const truncRight = truncateToWidth(right, available, "");
    const trw = visibleWidth(truncRight);
    return left + " ".repeat(width - lw - trw) + truncRight;
  }
  return truncateToWidth(left, width, "...");
}
