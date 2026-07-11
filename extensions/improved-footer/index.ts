/**
 * Improved Footer Extension
 *
 * Replaces pi's default footer with one that:
 * - Shows jj bookmark (jj:name) instead of git branch, with git fallback
 * - Shows the session's running net cost as [$XX.XX] next to the model's
 *   input/output rates. The cost is recomputed from the current session-tree
 *   branch, so /tree rewinds are reflected immediately and a new session
 *   starts back at $0.00.
 * - Includes subagent spend (@tintinweb/pi-subagents): live cost is
 *   accumulated by subscribing to each subagent's in-process session, and
 *   the final amount is persisted as a custom session entry so it survives
 *   rewind/resume anchored where the agent completed.
 * - Uses OpenRouter's /api/v1/generation API for accurate cost tracking of
 *   openrouter responses, and falls back to OpenRouter catalog pricing
 *   (vendor-preferring fuzzy match) when pi reports zero cost — e.g.
 *   subscription models or gateway-prefixed model ids.
 *
 * Footer layout mirrors pi's default exactly:
 *   Line 1: ~/cwd (jj:bookmark) • session-name
 *   Line 2: ↑tokens ↓tokens Rcache Wcache ctx%/window  model $in/$out [$cost] • thinking
 *   Line 3: extension statuses
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { execFile } from "child_process";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

/** customType of the session entry that records a finished subagent's cost. */
const SUBAGENT_COST_ENTRY = "improved-footer:subagent-cost";

// ─── Jujutsu Bookmark Detection (async, activity-triggered) ───────────────

function execAsync(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

async function detectJjRepo(cwd: string): Promise<boolean> {
  const result = await execAsync("jj", ["root", "--quiet"], cwd);
  return result !== null;
}

async function resolveJjBookmark(cwd: string): Promise<string | null> {
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

// ─── OpenRouter Pricing ────────────────────────────────────────────────────

/** USD-per-token rates for one model. */
export interface Rates {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingIndex {
  /** normalized full slug ("anthropic/claude-sonnet-5") → rates */
  byId: Map<string, Rates>;
  /** normalized model name ("claude-sonnet-5") → all catalog entries sharing it */
  byBase: Map<string, Array<{ id: string; author: string; rates: Rates }>>;
}

/** Model authors on OpenRouter that are first-party vendors (not resellers/finetuners). */
const KNOWN_VENDORS = new Set([
  "anthropic", "openai", "google", "meta-llama", "mistralai", "deepseek",
  "qwen", "x-ai", "amazon", "cohere", "moonshotai", "z-ai", "minimax",
  "nvidia", "microsoft", "ai21", "perplexity", "inception",
]);

/** Lowercase and fold "." to "-" so "gpt-4.1" and "gpt-4-1" compare equal. */
export function normalizeSlug(s: string): string {
  return s.toLowerCase().replace(/\./g, "-");
}

/**
 * Resolve USD-per-token rates for a model id against the OpenRouter catalog.
 *
 * Handles the three shapes ids arrive in:
 *  - direct/subscription: "claude-sonnet-5" (no author prefix)
 *  - openrouter:          "anthropic/claude-sonnet-5" (exact catalog slug)
 *  - private gateways:    "corp-gw/anthropic/claude-sonnet-5" (extra prefixes)
 * plus dot/dash and date-suffix drift. When several catalog entries share a
 * model name, the vendor-authored slug wins over resellers.
 */
export function lookupRates(index: PricingIndex, rawId: string): Rates | null {
  const norm = normalizeSlug(rawId);
  const attempts = [norm];
  // Date-suffixed ids ("claude-haiku-4-5-20251001") and "-latest" aliases
  const dateless = norm.replace(/-\d{6,8}$/, "").replace(/-latest$/, "");
  if (dateless !== norm) attempts.push(dateless);

  for (const attempt of attempts) {
    // Exact slug, then progressively strip gateway prefixes:
    // "corp/anthropic/claude-x" → "anthropic/claude-x" → base-name match.
    const segments = attempt.split("/");
    for (let i = 0; i < segments.length; i++) {
      const hit = index.byId.get(segments.slice(i).join("/"));
      if (hit) return hit;
    }
    const base = segments[segments.length - 1];
    const candidates = index.byBase.get(base);
    if (candidates?.length) {
      const localParts = new Set(segments.slice(0, -1));
      let best: { id: string; author: string; rates: Rates } | null = null;
      let bestScore = -1;
      for (const c of candidates) {
        // Prefer the vendor's own listing over reseller/finetune authors.
        let score = 0;
        if (localParts.has(c.author)) score += 2;
        if (KNOWN_VENDORS.has(c.author)) score += 1;
        if (score > bestScore || (score === bestScore && best && c.id.length < best.id.length)) {
          best = c;
          bestScore = score;
        }
      }
      if (best) return best.rates;
    }
  }
  return null;
}

async function fetchGenerationCost(
  responseId: string,
  apiKey: string,
): Promise<number | null> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${responseId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!data || typeof data.total_cost !== "number") return null;
    return data.total_cost;
  } catch {
    return null;
  }
}

/**
 * Fetch OpenRouter's model catalog and build the pricing index.
 * `pricing.*` fields are USD-per-token strings; cache rates may be absent.
 */
async function fetchPricingIndex(apiKey: string | null): Promise<PricingIndex | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!Array.isArray(data)) return null;

    const byId = new Map<string, Rates>();
    const byBase = new Map<string, Array<{ id: string; author: string; rates: Rates }>>();
    for (const m of data) {
      const id = m?.id;
      const p = m?.pricing;
      if (typeof id !== "string" || !p) continue;
      const prompt = parseFloat(p.prompt);
      const completion = parseFloat(p.completion);
      if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
      const cacheRead = parseFloat(p.input_cache_read);
      const cacheWrite = parseFloat(p.input_cache_write);
      const rates: Rates = {
        prompt,
        completion,
        cacheRead: Number.isFinite(cacheRead) ? cacheRead : 0,
        cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : 0,
      };
      const norm = normalizeSlug(id);
      byId.set(norm, rates);
      // Variant slugs (":free", ":extended") always have a base entry — keep
      // the name index clean of them so fuzzy matches land on real pricing.
      if (norm.includes(":")) continue;
      const slash = norm.lastIndexOf("/");
      const author = slash >= 0 ? norm.slice(0, slash) : "";
      const base = slash >= 0 ? norm.slice(slash + 1) : norm;
      let list = byBase.get(base);
      if (!list) byBase.set(base, (list = []));
      list.push({ id: norm, author, rates });
    }
    return { byId, byBase };
  } catch {
    return null;
  }
}

/** Format a USD-per-token rate as a per-million-token price (e.g. $15, $3.5, $0.27). */
function formatRate(perToken: number): string {
  const perM = perToken * 1_000_000;
  if (perM === 0) return "$0";
  if (perM >= 10) return `$${Math.round(perM)}`;
  if (perM >= 1) return `$${perM.toFixed(1)}`;
  return `$${perM.toFixed(2)}`;
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

// ─── pi-subagents interop ──────────────────────────────────────────────────

/** Cross-package registry pi-subagents publishes its manager under. */
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

function getSubagentRecord(id: string): any | null {
  try {
    const mgr = (globalThis as any)[SUBAGENT_MANAGER_KEY];
    return mgr?.getRecord?.(id) ?? null;
  } catch {
    return null;
  }
}

// ─── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | null = null;
  let openRouterApiKey: string | null = null;
  // OpenRouter pricing index, fetched once and cached for the process.
  let pricing: PricingIndex | null = null;
  let pricingFetchStarted = false;
  // Per-model-id fuzzy resolution cache; cleared when the catalog arrives.
  const resolvedRates = new Map<string, Rates | null>();
  let footerTui: { requestRender: () => void } | null = null;
  let modelId = "";
  let thinkingLevel = "off";

  // ─── Branch-derived session totals (recomputed on message/tree events) ──
  // Everything here follows the *current* session-tree branch, so a rewind
  // via /tree immediately reflects the totals as of that point.
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  /** Cost of the current branch: assistant messages + finished-subagent entries. */
  let branchCost = 0;

  /** OpenRouter generation-API costs keyed by responseId. Kept for the whole
   *  process so branch recomputes after a rewind still find fetched values. */
  const genCosts = new Map<string, number>();
  const genPending = new Set<string>();

  /** Live (still-running) subagents: id → accumulated cost so far. */
  interface SubagentTrack {
    cost: number;
    counted: WeakSet<object>;
    unsub: (() => void) | null;
    attachTimer: ReturnType<typeof setInterval> | null;
  }
  const liveSubagents = new Map<string, SubagentTrack>();

  // ─── VCS state: jj bookmark (activity-triggered), git from FooterDataProvider ──
  let jjBookmark: string | null = null;
  let isJjRepo = false;
  let vcsCwd: string | null = null;

  function requestRender() {
    footerTui?.requestRender();
  }

  // ─── Pricing resolution ─────────────────────────────────────────────────

  /** Cached lookupRates against the fetched catalog. */
  function resolveRates(id: string): Rates | null {
    if (!pricing || !id) return null;
    const cached = resolvedRates.get(id);
    if (cached !== undefined) return cached;
    const result = lookupRates(pricing, id);
    resolvedRates.set(id, result);
    return result;
  }

  // ─── Cost computation ───────────────────────────────────────────────────

  /**
   * Cost of one assistant message, best source first:
   * OpenRouter generation API (when fetched) → pi's built-in usage cost →
   * OpenRouter catalog estimate for models pi has no pricing for.
   */
  function messageCost(msg: AssistantMessage): number {
    if (msg.provider === "openrouter" && msg.responseId) {
      const fetched = genCosts.get(msg.responseId);
      if (fetched !== undefined) return fetched;
    }
    const piCost = msg.usage?.cost?.total ?? 0;
    if (piCost > 0) return piCost;
    const rates = resolveRates(msg.model);
    if (!rates) return 0;
    const u = msg.usage;
    if (!u) return 0;
    return (
      u.input * rates.prompt +
      u.output * rates.completion +
      u.cacheRead * rates.cacheRead +
      u.cacheWrite * rates.cacheWrite
    );
  }

  /** Recompute token totals and cost from the current branch (root → leaf). */
  function recomputeFromBranch() {
    const sm = currentCtx?.sessionManager;
    if (!sm) return;
    let branch: SessionEntry[];
    try {
      branch = sm.getBranch();
    } catch {
      return;
    }
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const entry of branch) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const msg = entry.message as AssistantMessage;
        const u = msg.usage;
        if (u) {
          input += u.input;
          output += u.output;
          cacheRead += u.cacheRead;
          cacheWrite += u.cacheWrite;
        }
        cost += messageCost(msg);
      } else if (entry.type === "custom" && entry.customType === SUBAGENT_COST_ENTRY) {
        const c = (entry.data as any)?.cost;
        if (typeof c === "number" && Number.isFinite(c)) cost += c;
      }
    }
    totalInput = input;
    totalOutput = output;
    totalCacheRead = cacheRead;
    totalCacheWrite = cacheWrite;
    branchCost = cost;
  }

  /** Net running cost: current branch + subagents still running. */
  function sessionCost(): number {
    let cost = branchCost;
    for (const track of liveSubagents.values()) cost += track.cost;
    return cost;
  }

  function ensurePricing(ctx: ExtensionContext) {
    if (pricing || pricingFetchStarted) return;
    pricingFetchStarted = true;
    if (!openRouterApiKey) openRouterApiKey = getOpenRouterApiKey(ctx);
    void fetchPricingIndex(openRouterApiKey).then((index) => {
      if (index) {
        pricing = index;
        resolvedRates.clear();
        recomputeFromBranch();
        requestRender();
      } else {
        pricingFetchStarted = false; // allow a later retry
      }
    });
  }

  // ─── Subagent cost tracking (@tintinweb/pi-subagents) ───────────────────
  // Subagents run in-process but on their own session/event bus, so the
  // parent's message_end never fires for them. Instead we subscribe to each
  // subagent session directly (via the manager's Symbol.for registry) and
  // accumulate per-message cost live. On completion the total is persisted
  // as a custom entry in the parent session, anchored at the current leaf —
  // which makes it rewind- and resume-accurate from then on.

  function countSubagentMessage(track: SubagentTrack, msg: AssistantMessage) {
    if (track.counted.has(msg)) return;
    track.counted.add(msg);
    track.cost += messageCost(msg);
    requestRender();
  }

  function trackSubagent(id: string) {
    if (liveSubagents.has(id)) return;
    const track: SubagentTrack = { cost: 0, counted: new WeakSet(), unsub: null, attachTimer: null };
    liveSubagents.set(id, track);

    const tryAttach = (): boolean => {
      const session = getSubagentRecord(id)?.session;
      if (!session?.subscribe) return false;
      try {
        track.unsub = session.subscribe((event: any) => {
          if (event?.type === "message_end" && event.message?.role === "assistant") {
            countSubagentMessage(track, event.message);
          }
        });
        // Catch up on messages that finished before we attached; the WeakSet
        // dedupes against events racing this snapshot.
        for (const msg of session.messages ?? []) {
          if (msg?.role === "assistant") countSubagentMessage(track, msg);
        }
        return true;
      } catch {
        return false;
      }
    };

    // The session is created asynchronously after spawn — poll briefly.
    if (!tryAttach()) {
      let attempts = 0;
      track.attachTimer = setInterval(() => {
        if (tryAttach() || ++attempts >= 120) {
          if (track.attachTimer) clearInterval(track.attachTimer);
          track.attachTimer = null;
        }
      }, 500);
      track.attachTimer.unref?.();
    }
  }

  function finalizeSubagent(id: string, tokens?: { input: number; output: number; total: number }) {
    const track = liveSubagents.get(id);
    if (!track) return;
    track.unsub?.();
    if (track.attachTimer) clearInterval(track.attachTimer);
    liveSubagents.delete(id);

    // Attach never succeeded (e.g. race lost, session gone) — estimate from
    // the lifetime token totals the completion event carries. cacheRead isn't
    // reported there, so this floor slightly undercounts cached agents.
    if (track.cost === 0 && tokens && tokens.total > 0) {
      const subModelId = getSubagentRecord(id)?.session?.model?.id ?? modelId;
      const rates = resolveRates(subModelId);
      if (rates) {
        const cacheWrite = Math.max(0, tokens.total - tokens.input - tokens.output);
        track.cost =
          tokens.input * rates.prompt +
          tokens.output * rates.completion +
          cacheWrite * rates.cacheWrite;
      }
    }

    // Persist into the session tree so rewinds/resumes account for it at the
    // point the agent finished.
    if (track.cost > 0) {
      try {
        pi.appendEntry(SUBAGENT_COST_ENTRY, { id, cost: track.cost });
      } catch { /* no active session to write to */ }
      recomputeFromBranch();
    }
    requestRender();
  }

  function dropLiveSubagents() {
    for (const track of liveSubagents.values()) {
      track.unsub?.();
      if (track.attachTimer) clearInterval(track.attachTimer);
    }
    liveSubagents.clear();
  }

  pi.events.on("subagents:started", (data) => {
    const id = (data as any)?.id;
    if (typeof id === "string") trackSubagent(id);
  });
  pi.events.on("subagents:completed", (data) => {
    const d = data as any;
    if (typeof d?.id === "string") finalizeSubagent(d.id, d.tokens);
  });
  pi.events.on("subagents:failed", (data) => {
    const d = data as any;
    if (typeof d?.id === "string") finalizeSubagent(d.id, d.tokens);
  });

  // ─── VCS refresh ────────────────────────────────────────────────────────

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

  pi.on("model_select", async (event, ctx) => {
    modelId = event.model.id;
    ensurePricing(ctx);
    requestRender();
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    thinkingLevel = event.level;
    requestRender();
  });

  // ─── Event: session-tree navigation (rewind/branch) ────────────────────

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    recomputeFromBranch();
    requestRender();
  });

  // ─── Event: track cost from responses ──────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    currentCtx = ctx;
    recomputeFromBranch();

    // Refresh jj bookmark on activity (cheap: only fires when user is interacting)
    refreshJjBookmark();

    if (event.message.provider === "openrouter") {
      // OpenRouter: refine with the generation API's exact provider-agnostic cost
      const responseId = event.message.responseId;
      if (!responseId || !responseId.startsWith("gen-")) return;
      if (genCosts.has(responseId) || genPending.has(responseId)) return;
      genPending.add(responseId);

      if (!openRouterApiKey) {
        openRouterApiKey = getOpenRouterApiKey(ctx);
      }
      if (!openRouterApiKey) {
        genPending.delete(responseId);
        return;
      }

      const cost = await fetchGenerationCost(responseId, openRouterApiKey);
      genPending.delete(responseId);
      if (cost === null) return;
      genCosts.set(responseId, cost);
      recomputeFromBranch();
    }

    requestRender();
  });

  // ─── Session start: install custom footer ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    dropLiveSubagents();
    modelId = ctx.model?.id ?? "";
    thinkingLevel = pi.getThinkingLevel();
    vcsCwd = ctx.cwd;
    isJjRepo = await detectJjRepo(ctx.cwd);
    ensurePricing(ctx);

    // Derive totals from the loaded session's current branch (zero for /new,
    // restored for /resume, trimmed to the branch point for forks).
    recomputeFromBranch();

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

          // ── Line 2: Token stats + context % | right-aligned model + cost ──
          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

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

          // Model + per-token rates + running session cost + thinking on the right
          const mId = modelId || ctx.model?.id || "no-model";
          const rate = resolveRates(mId);
          const costLabel = `[$${sessionCost().toFixed(2)}]`;
          const modelLabel = rate
            ? `${mId} ${formatRate(rate.prompt)}/${formatRate(rate.completion)} ${costLabel}`
            : `${mId} ${costLabel}`;
          let rightSide = modelLabel;
          if (ctx.model?.reasoning) {
            const tl = thinkingLevel || "off";
            rightSide = tl === "off" ? `${modelLabel} • thinking off` : `${modelLabel} • ${tl}`;
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
    dropLiveSubagents();
    currentCtx = null;
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
