/**
 * stats.ts — always-on usage statistics for read/edit tooling.
 *
 * Stored as a single atomic JSON file at ~/.pi/agent/hashline-stats.json. Every
 * read/edit-class tool result is recorded into one of two buckets — `active`
 * (hashline mode toggled ON at the time) or `inactive` (the native-edit
 * baseline) — so we can compare hashline against the built-in edit flow.
 *
 * Writes are read-modify-write with a temp-file + rename for atomicity; a
 * missing or corrupt file is tolerated by starting fresh.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Counters = {
  edit_calls: number;
  edit_successes: number;
  edit_failures: number;
  hash_mismatch_rejections: number;
  read_calls: number;
  firstSeen: string | null;
  lastUpdated: string | null;
};

export type RecentEvent = {
  ts: string;
  tool: string;
  path: string;
  isError: boolean;
  kind: "edit" | "read" | "hash_mismatch";
};

export type StatsFile = {
  version: 1;
  active: Counters;
  inactive: Counters;
  recent: RecentEvent[];
};

export type EventInput = {
  bucket: "active" | "inactive";
  tool: string;
  path: string;
  isError: boolean;
  kind: "edit" | "read";
  /** Set for hashline_edit rejections caused by an anchor hash mismatch. */
  hashMismatch?: boolean;
};

const MAX_RECENT = 500;

export function defaultStatsPath(): string {
  return join(getAgentDir(), "hashline-stats.json");
}

function emptyCounters(): Counters {
  return {
    edit_calls: 0,
    edit_successes: 0,
    edit_failures: 0,
    hash_mismatch_rejections: 0,
    read_calls: 0,
    firstSeen: null,
    lastUpdated: null,
  };
}

function emptyStats(): StatsFile {
  return { version: 1, active: emptyCounters(), inactive: emptyCounters(), recent: [] };
}

/** Read the stats file, tolerating absence/corruption by returning a fresh struct. */
export function readStats(path = defaultStatsPath()): StatsFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyStats();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StatsFile>;
    return {
      version: 1,
      active: { ...emptyCounters(), ...(parsed.active ?? {}) },
      inactive: { ...emptyCounters(), ...(parsed.inactive ?? {}) },
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-MAX_RECENT) : [],
    };
  } catch {
    return emptyStats();
  }
}

/** Atomically write stats: temp file in the same dir + rename. */
function writeStats(stats: StatsFile, path = defaultStatsPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.hashline-stats.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Record one tool event into the appropriate bucket and append to the bounded
 * recent log. Read-modify-write under the hood; returns the updated stats.
 */
export function recordEvent(input: EventInput, path = defaultStatsPath()): StatsFile {
  const stats = readStats(path);
  const c = stats[input.bucket];
  const now = new Date().toISOString();
  if (c.firstSeen === null) c.firstSeen = now;
  c.lastUpdated = now;

  if (input.kind === "read") {
    c.read_calls += 1;
  } else {
    c.edit_calls += 1;
    if (input.isError) c.edit_failures += 1;
    else c.edit_successes += 1;
    if (input.hashMismatch) c.hash_mismatch_rejections += 1;
  }

  stats.recent.push({
    ts: now,
    tool: input.tool,
    path: input.path,
    isError: input.isError,
    kind: input.hashMismatch ? "hash_mismatch" : input.kind,
  });
  if (stats.recent.length > MAX_RECENT) stats.recent = stats.recent.slice(-MAX_RECENT);

  writeStats(stats, path);
  return stats;
}
