/**
 * Git fetch/clone logic and marketplace.json resolution for the
 * claude-marketplace extension.
 *
 * All network operations use `gh repo clone` / `gh repo sync` when a GitHub
 * URL is detected, falling back to plain `git clone` / `git pull` for other
 * HTTPS URLs.  The `gh` CLI handles authentication transparently, so no
 * credentials need to be stored in the config.
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

import { exec as execCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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

const execAsync = promisify(execCallback);

function cacheDir(): string {
  return join(piAgentDir(), "marketplace-cache");
}

/** Absolute path to the cached clone for a marketplace. */
export function marketplaceCacheDir(name: string): string {
  return join(cacheDir(), name);
}

async function exec(command: string, cwd: string): Promise<void> {
  await execAsync(command, { cwd, timeout: 120_000 });
}

/** Returns true if the source looks like a GitHub URL (shorthand or HTTPS). */
function isGithubSource(source: string): boolean {
  return source.startsWith("github.com/") || source.includes("github.com/");
}

// ─── Clone ────────────────────────────────────────────────────────────────────

/**
 * Ensure the marketplace is cloned locally.
 *
 * - Local paths: nothing to do.
 * - GitHub sources: `gh repo clone <repo> <dest> -- --depth=1`
 * - Other HTTPS URLs: `git clone --depth=1 <url> <dest>`
 *
 * If the destination already exists the function is a no-op (idempotent).
 *
 * @throws if the clone command fails.
 */
export async function ensureCloned(entry: MarketplaceEntry): Promise<void> {
  if (isLocalSource(entry.source)) return; // Local path — nothing to clone

  const dest = marketplaceCacheDir(entry.name);
  if (existsSync(dest)) return; // Already cloned

  mkdirSync(dirname(dest), { recursive: true });

  const cloneUrl = toCloneUrl(entry.source);
  if (!cloneUrl) return; // Should not happen given the isLocalSource check above

  const branch = entry.branch ?? "main";

  try {
    if (isGithubSource(entry.source)) {
      // gh repo clone accepts "org/repo" or a full URL
      const ghTarget = cloneUrl.replace("https://github.com/", "");
      await exec(
        `gh repo clone ${ghTarget} "${dest}" -- --depth=1 --branch=${branch}`,
        cacheDir(),
      );
    } else {
      await exec(
        `git clone --depth=1 --branch=${branch} ${cloneUrl} "${dest}"`,
        cacheDir(),
      );
    }
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
 * - GitHub sources: `gh repo sync` inside the clone dir.
 * - Other HTTPS URLs: `git pull` inside the clone dir.
 *
 * @param entry          Marketplace config entry.
 * @param intervalHours  Hours between refreshes (0 = never).
 * @returns              true if a pull was performed, false if skipped.
 * @throws               if the pull command fails.
 */
export async function pullIfStale(entry: MarketplaceEntry, intervalHours: number): Promise<boolean> {
  if (isLocalSource(entry.source)) return false;
  if (!isStale(entry.name, intervalHours)) return false;

  const dest = marketplaceCacheDir(entry.name);
  if (!existsSync(dest)) {
    // Cache dir disappeared — re-clone instead
    await ensureCloned(entry);
    return true;
  }

  try {
    if (isGithubSource(entry.source)) {
      await exec("gh repo sync --force", dest);
    } else {
      await exec("git pull --ff-only", dest);
    }
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
 * - GitHub sources: `gh repo sync --force`.
 * - Other HTTPS URLs: `git pull`.
 *
 * @throws if the pull command fails.
 */
export async function forcePull(entry: MarketplaceEntry): Promise<void> {
  if (isLocalSource(entry.source)) return;

  const dest = marketplaceCacheDir(entry.name);
  if (!existsSync(dest)) {
    await ensureCloned(entry);
    return;
  }

  try {
    if (isGithubSource(entry.source)) {
      await exec("gh repo sync --force", dest);
    } else {
      await exec("git pull --ff-only", dest);
    }
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


