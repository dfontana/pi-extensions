/**
 * Persistent state for the claude-marketplace extension.
 *
 * Stored at: ~/.pi/agent/marketplace-state.json
 *
 * Schema:
 * {
 *   "<marketplace-name>": {
 *     "lastUpdated": "2025-01-01T00:00:00.000Z"   // ISO-8601
 *   }
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "./config.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketplaceState {
  lastUpdated: string; // ISO-8601
}

export type StateFile = Record<string, MarketplaceState>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statePath(): string {
  return join(piAgentDir(), "marketplace-state.json");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read the full state file, returning an empty object if it doesn't exist. */
export function readState(): StateFile {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as StateFile;
  } catch {
    // Corrupt file — start fresh; it will be overwritten on next write
    return {};
  }
}

/** Persist the full state object. Creates parent directories if needed. */
function writeState(state: StateFile): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Record that a marketplace was successfully updated right now. */
export function markUpdated(marketplaceName: string): void {
  const state = readState();
  state[marketplaceName] = { lastUpdated: new Date().toISOString() };
  writeState(state);
}

/**
 * Return true if the marketplace needs a refresh.
 *
 * @param marketplaceName  Key in the state file.
 * @param intervalHours    How many hours between refreshes. 0 → never.
 */
export function isStale(marketplaceName: string, intervalHours: number): boolean {
  if (intervalHours === 0) return false;

  const state = readState();
  const entry = state[marketplaceName];
  if (!entry?.lastUpdated) return true; // Never updated → stale

  const lastUpdated = new Date(entry.lastUpdated);
  if (Number.isNaN(lastUpdated.getTime())) return true; // Corrupt date

  const ageMs = Date.now() - lastUpdated.getTime();
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return ageMs > intervalMs;
}

/** Return the last-updated date for a marketplace, or null if never updated. */
export function lastUpdated(marketplaceName: string): Date | null {
  const state = readState();
  const entry = state[marketplaceName];
  if (!entry?.lastUpdated) return null;
  const d = new Date(entry.lastUpdated);
  return Number.isNaN(d.getTime()) ? null : d;
}
