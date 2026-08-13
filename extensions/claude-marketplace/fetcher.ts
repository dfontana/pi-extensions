/**
 * Git fetch/clone logic and marketplace.json resolution for the
 * claude-marketplace extension.
 *
 * All network operations use plain git commands (`git clone` / `git fetch`).
 * Authentication is handled by git's own credential stack — SSH keys,
 * macOS Keychain, `git-credential-*` helpers, `.netrc`, etc. — with no
 * dependency on the `gh` CLI.
 *
 * For local-path sources, all git operations are skipped.
 *
 * marketplace.json schema (subset we care about):
 * {
 *   "plugins": [
 *     { "name": "dd",       "source": "./dd" },
 *     { "name": "metering", "source": "./metering" },
 *     …
 *   ]
 * }
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type MarketplaceEntry, isLocalSource, piAgentDir, toCloneUrl } from "./config.ts";
import { isStale, markUpdated } from "./state.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketplacePlugin {
  name: string;
  /** Resolved absolute path to the plugin directory inside the marketplace clone. */
  path: string;
}

export interface ResolvedPaths {
  /** Absolute paths to directories containing `<skill-name>/SKILL.md` trees. */
  skillPaths: string[];
  /** Warnings for plugins that were requested but not found in marketplace.json. */
  warnings: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 120_000;

/** A pi.exec-compatible runner, injectable so Git argv construction is testable. */
export type ExecRunner = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

function cacheDir(): string {
  return join(piAgentDir(), "marketplace-cache");
}

/** Absolute path to the cached clone for a marketplace. */
export function marketplaceCacheDir(name: string): string {
  return join(cacheDir(), name);
}

async function execGit(runner: ExecRunner, args: string[], cwd: string): Promise<void> {
  const result = await runner("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  if (result.code === 0 && !result.killed) return;

  const detail = (result.stderr || result.stdout).trim();
  const action = args[0] ?? "command";
  if (result.killed) {
    throw new Error(
      `git ${action} timed out or was aborted${detail ? `: ${detail}` : ""}`,
    );
  }
  throw new Error(
    `git ${action} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
  );
}

// ─── Clone ────────────────────────────────────────────────────────────────────

/**
 * Ensure the marketplace is cloned locally.
 *
 * - Local paths: nothing to do.
 * - Remote sources: `git clone --depth=1 <url> <dest>`
 *
 * If the destination already exists the function is a no-op (idempotent).
 *
 * @throws if the clone command fails.
 */
export async function ensureCloned(entry: MarketplaceEntry, runner: ExecRunner): Promise<void> {
  if (isLocalSource(entry.source)) return; // Local path — nothing to clone

  const dest = marketplaceCacheDir(entry.name);
  if (existsSync(dest)) return; // Already cloned

  mkdirSync(dirname(dest), { recursive: true });

  const cloneUrl = toCloneUrl(entry.source);
  if (!cloneUrl) return; // Should not happen given the isLocalSource check above

  const branch = entry.branch ?? "main";

  try {
    await execGit(
      runner,
      ["clone", "--depth=1", "--branch", branch, "--", cloneUrl, dest],
      cacheDir(),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to clone marketplace "${entry.name}" from ${entry.source}:\n${msg}`,
    );
  }

  // Mark as updated so the first pull is correctly scheduled
  markUpdated(entry.name);
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

/**
 * Pull the latest changes for a marketplace if it is stale.
 *
 * - Local paths: always a no-op.
 * - Remote sources: `git fetch --depth=1 origin && git reset --hard FETCH_HEAD`
 *   inside the clone dir.  Using `reset --hard` rather than `pull --ff-only`
 *   keeps shallow clones working even when the remote history has been rewritten.
 *
 * @param entry          Marketplace config entry.
 * @param intervalHours  Hours between refreshes (0 = never).
 * @returns              true if a pull was performed, false if skipped.
 * @throws               if the fetch/reset command fails.
 */
export async function pullIfStale(
  entry: MarketplaceEntry,
  intervalHours: number,
  runner: ExecRunner,
): Promise<boolean> {
  if (isLocalSource(entry.source)) return false;
  if (!isStale(entry.name, intervalHours)) return false;

  const dest = marketplaceCacheDir(entry.name);
  if (!existsSync(dest)) {
    // Cache dir disappeared — re-clone instead
    await ensureCloned(entry, runner);
    return true;
  }

  try {
    await execGit(runner, ["fetch", "--depth=1", "origin"], dest);
    await execGit(runner, ["reset", "--hard", "FETCH_HEAD"], dest);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to update marketplace "${entry.name}" from ${entry.source}:\n${msg}`,
    );
  }

  markUpdated(entry.name);
  return true;
}

/**
 * Unconditionally pull the latest changes for a marketplace, regardless of
 * staleness.  Used by the `/marketplace update` command.
 *
 * - Local paths: no-op.
 * - Remote sources: `git fetch --depth=1 origin && git reset --hard FETCH_HEAD`.
 *
 * @throws if the fetch/reset command fails.
 */
export async function forcePull(entry: MarketplaceEntry, runner: ExecRunner): Promise<void> {
  if (isLocalSource(entry.source)) return;

  const dest = marketplaceCacheDir(entry.name);
  if (!existsSync(dest)) {
    await ensureCloned(entry, runner);
    return;
  }

  try {
    await execGit(runner, ["fetch", "--depth=1", "origin"], dest);
    await execGit(runner, ["reset", "--hard", "FETCH_HEAD"], dest);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to force-update marketplace "${entry.name}" from ${entry.source}:\n${msg}`,
    );
  }

  markUpdated(entry.name);
}

// ─── marketplace.json parsing ────────────────────────────────────────────────

interface RawMarketplacePlugin {
  name: string;
  source: string;
}

interface RawMarketplaceJson {
  plugins: RawMarketplacePlugin[];
}

/**
 * Parse `<marketplaceRoot>/.claude-plugin/marketplace.json` and return a map
 * of plugin name → resolved absolute plugin directory.
 *
 * @throws if the file is missing or malformed.
 */
function parseMarketplaceJson(marketplaceRoot: string): Map<string, string> {
  const jsonPath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(jsonPath)) {
    throw new Error(
      `marketplace.json not found at ${jsonPath}. ` +
      `Is "${marketplaceRoot}" a valid Claude marketplace?`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${jsonPath}: ${msg}`);
  }

  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).plugins)
  ) {
    throw new Error(`${jsonPath} must be a JSON object with a "plugins" array`);
  }

  const { plugins } = raw as RawMarketplaceJson;
  const pluginMap = new Map<string, string>();

  for (const plugin of plugins) {
    if (typeof plugin.name !== "string" || typeof plugin.source !== "string") continue;
    // Resolve the source path relative to the marketplace root, disallowing
    // path traversal above the repo root (mirrors Claude Code's own restriction).
    const resolved = resolve(marketplaceRoot, plugin.source);
    if (!resolved.startsWith(marketplaceRoot)) {
      // Path traversal — skip (consistent with Claude Code's installer behaviour)
      continue;
    }
    pluginMap.set(plugin.name, resolved);
  }

  return pluginMap;
}

// ─── Skill/Prompt path resolution ────────────────────────────────────────────

/**
 * Resolve the skill paths for the requested plugins in a marketplace.
 *
 * @param entry  Marketplace config entry (name, source, plugins).
 * @returns      Skill paths to inject + any warnings for missing plugins.
 */
export function resolvePluginPaths(entry: MarketplaceEntry): ResolvedPaths {
  const marketplaceRoot = isLocalSource(entry.source)
    ? resolve(entry.source)
    : marketplaceCacheDir(entry.name);

  let pluginMap: Map<string, string>;
  try {
    pluginMap = parseMarketplaceJson(marketplaceRoot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      skillPaths: [],
      warnings: [`[${entry.name}] ${msg}`],
    };
  }

  const skillPaths: string[] = [];
  const warnings: string[] = [];
  const disabledSet = new Set(entry.disabledPlugins ?? []);

  for (const pluginName of entry.plugins) {
    if (disabledSet.has(pluginName)) {
      console.info(
        `[claude-marketplace] [${entry.name}] Plugin "${pluginName}" is disabled — skipping.`,
      );
      continue;
    }

    const pluginDir = pluginMap.get(pluginName);
    if (!pluginDir) {
      warnings.push(
        `[${entry.name}] Plugin "${pluginName}" not found in marketplace.json. ` +
        `Available: ${[...pluginMap.keys()].sort().join(", ")}`,
      );
      continue;
    }

    if (!existsSync(pluginDir)) {
      warnings.push(
        `[${entry.name}] Plugin directory for "${pluginName}" does not exist: ${pluginDir}`,
      );
      continue;
    }

    // Pi expects a skillPaths entry to be a directory containing
    // subdirectories each with a SKILL.md file.
    const skillsDir = join(pluginDir, "skills");
    if (existsSync(skillsDir)) {
      skillPaths.push(skillsDir);
    }
    // (agents/ and commands/ are intentionally not surfaced)
  }

  return { skillPaths, warnings };
}


