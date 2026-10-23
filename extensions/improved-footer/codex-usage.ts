export interface CodexUsageWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface CodexUsageSnapshot {
  fiveHour?: CodexUsageWindow;
  weekly?: CodexUsageWindow;
}

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Extracts the ChatGPT account id from the Codex OAuth access token's JWT claim. */
export function getCodexAccountId(accessToken: string): string | undefined {
  try {
    const payloadSegment = accessToken.split(".")[1];
    if (!payloadSegment) return undefined;
    const payload = asRecord(JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")));
    const auth = asRecord(payload?.["https://api.openai.com/auth"]);
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/** Parse Codex's usage payload, identifying windows by duration rather than field order. */
export function parseCodexUsage(payload: unknown): CodexUsageSnapshot | undefined {
  const limits = asRecord(asRecord(payload)?.rate_limit);
  if (!limits) return undefined;

  const snapshot: CodexUsageSnapshot = {};
  for (const candidate of [limits.primary_window, limits.secondary_window]) {
    const window = asRecord(candidate);
    if (!window) continue;

    const usedPercent = window.used_percent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;

    const resetAt = window.reset_at;
    const parsedWindow: CodexUsageWindow = {
      usedPercent,
      ...(typeof resetAt === "number" && Number.isFinite(resetAt) ? { resetsAt: resetAt } : {}),
    };

    if (window.limit_window_seconds === FIVE_HOUR_WINDOW_SECONDS) snapshot.fiveHour = parsedWindow;
    else if (window.limit_window_seconds === WEEKLY_WINDOW_SECONDS) snapshot.weekly = parsedWindow;
  }

  return snapshot.fiveHour || snapshot.weekly ? snapshot : undefined;
}

export async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CodexUsageSnapshot | undefined> {
  try {
    const response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseCodexUsage(await response.json());
  } catch {
    return undefined;
  }
}

function formatResetTime(resetsAt: number, nowMs: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - nowMs) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours ? `${remainingHours}h` : ""}`;
}

function formatWindow(label: string, window: CodexUsageWindow, nowMs: number): string {
  const remainingPercent = Math.round(100 - window.usedPercent);
  const reset = window.resetsAt === undefined ? "" : ` (${formatResetTime(window.resetsAt, nowMs)})`;
  return `${label} ${remainingPercent}% left${reset}`;
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot, nowMs = Date.now()): string {
  const parts = [
    snapshot.fiveHour ? formatWindow("5h", snapshot.fiveHour, nowMs) : undefined,
    snapshot.weekly ? formatWindow("wk", snapshot.weekly, nowMs) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? `Codex ${parts.join(" · ")}` : "";
}
