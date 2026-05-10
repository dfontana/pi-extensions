/**
 * Config loader for the claude-marketplace extension.
 *
 * Reads and merges two optional config files:
 *   - Global:  ~/.pi/agent/marketplace-config.json
 *   - Project: <cwd>/.pi/marketplace-config.json  (overrides global)
 *
 * Project config's `marketplaces` array is merged by `name`: a project entry
 * with the same name as a global entry replaces that entry entirely; novel
 * names are appended.  Top-level scalar fields (`updateIntervalHours`) in the
 * project config override the global value.
 *
 * Config schema
 * ─────────────
 * {
 *   "marketplaces": [
 *     {
 *       "name": "acme",
 *       "source": "github.com/acme-corp/claude-marketplace",
 *       "branch": "main",          // optional, defaults to "main"
 *       "plugins": ["dd", "metering", "lakehouse"]
 *     },
 *     {
 *       "name": "local-dev",
 *       "source": "/absolute/path/to/local/clone",  // local paths skip git
 *       "plugins": ["my-plugin"]
 *     }
 *   ],
 *   "updateIntervalHours": 24    // 0 = never auto-update, default 24
 * }
 *
 * `source` accepts:
 *   - GitHub shorthand:   "github.com/org/repo"
 *   - Full HTTPS URL:     "https://github.com/org/repo"
 *   - Local abs path:     "/home/user/projects/my-marketplace"
 *
 * Local paths skip all git operations and are never "updated".
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketplaceEntry {
  /** Unique identifier used as the cache directory name. */
  name: string;
  /**
   * Where to find the marketplace.
   * - "github.com/org/repo"  → cloned via gh CLI
   * - "https://…"            → cloned via gh CLI (HTTPS URL passthrough)
   * - "/absolute/path"       → used in-place, no git operations
   */
  source: string;
  /** Branch, tag, or commit.  Defaults to "main". Only used for git sources. */
  branch?: string;
  /** Plugin names to install.  Must match keys in marketplace.json. */
  plugins: string[];
}

export interface MarketplaceConfig {
  marketplaces: MarketplaceEntry[];
  /**
   * How many hours between automatic `git pull` refreshes.
   * 0 = never auto-update.
   * Default: 24.
   */
  updateIntervalHours: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MarketplaceConfig = {
  marketplaces: [],
  updateIntervalHours: 24,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the Pi agent directory, respecting PI_CODING_AGENT_DIR if set. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readJson(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read/parse ${filePath}: ${msg}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateEntry(raw: unknown, index: number): MarketplaceEntry {
  if (!isRecord(raw)) {
    throw new Error(`marketplaces[${index}] must be an object`);
  }

  const { name, source, branch, plugins } = raw as Record<string, unknown>;

  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`marketplaces[${index}].name must be a non-empty string`);
  }
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(`marketplaces[${index}].source must be a non-empty string`);
  }
  if (branch !== undefined && typeof branch !== "string") {
    throw new Error(`marketplaces[${index}].branch must be a string if provided`);
  }
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error(`marketplaces[${index}].plugins must be a non-empty array`);
  }
  for (let i = 0; i < plugins.length; i++) {
    if (typeof plugins[i] !== "string" || (plugins[i] as string).trim() === "") {
      throw new Error(`marketplaces[${index}].plugins[${i}] must be a non-empty string`);
    }
  }

  return {
    name: name.trim(),
    source: source.trim(),
    branch: typeof branch === "string" ? branch.trim() : undefined,
    plugins: (plugins as string[]).map((p) => p.trim()),
  };
}

function validateConfig(raw: unknown, filePath: string): Partial<MarketplaceConfig> {
  if (!isRecord(raw)) {
    throw new Error(`Config file ${filePath} must be a JSON object`);
  }

  const { marketplaces, updateIntervalHours } = raw as Record<string, unknown>;

  const result: Partial<MarketplaceConfig> = {};

  if (marketplaces !== undefined) {
    if (!Array.isArray(marketplaces)) {
      throw new Error(`${filePath}: "marketplaces" must be an array`);
    }
    result.marketplaces = marketplaces.map((m, i) => validateEntry(m, i));

    // Ensure names are unique within the file
    const seen = new Set<string>();
    for (const { name } of result.marketplaces) {
      if (seen.has(name)) {
        throw new Error(`${filePath}: duplicate marketplace name "${name}"`);
      }
      seen.add(name);
    }
  }

  if (updateIntervalHours !== undefined) {
    if (typeof updateIntervalHours !== "number" || updateIntervalHours < 0) {
      throw new Error(`${filePath}: "updateIntervalHours" must be a non-negative number`);
    }
    result.updateIntervalHours = updateIntervalHours;
  }

  return result;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Deep-merge project config on top of global config.
 * - `marketplaces`: project entries with matching `name` replace global entries;
 *   novel names are appended.
 * - Scalar top-level fields: project value wins when present.
 */
function mergeConfigs(
  base: MarketplaceConfig,
  override: Partial<MarketplaceConfig>,
): MarketplaceConfig {
  const merged: MarketplaceConfig = { ...base };

  if (override.updateIntervalHours !== undefined) {
    merged.updateIntervalHours = override.updateIntervalHours;
  }

  if (override.marketplaces !== undefined) {
    const overrideMap = new Map(override.marketplaces.map((m) => [m.name, m]));
    // Keep base entries, replacing any that are overridden
    const result = base.marketplaces.map((m) => overrideMap.get(m.name) ?? m);
    // Append novel entries that don't exist in base
    for (const entry of override.marketplaces) {
      if (!base.marketplaces.some((m) => m.name === entry.name)) {
        result.push(entry);
      }
    }
    merged.marketplaces = result;
  }

  return merged;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LoadConfigResult {
  config: MarketplaceConfig;
  /** Path to global config, if it was found and loaded. */
  globalPath: string | null;
  /** Path to project config, if it was found and loaded. */
  projectPath: string | null;
}

/**
 * Load, validate, and merge marketplace configs.
 *
 * @param cwd  Current working directory (used to find project-local config).
 * @returns    Merged config plus metadata about which files were found.
 * @throws     If a config file exists but fails to parse or validate.
 */
export function loadConfig(cwd: string): LoadConfigResult {
  const agentDir = piAgentDir();
  const globalPath = join(agentDir, "marketplace-config.json");
  const projectPath = join(cwd, ".pi", "marketplace-config.json");

  let config: MarketplaceConfig = { ...DEFAULT_CONFIG };
  let foundGlobal: string | null = null;
  let foundProject: string | null = null;

  if (existsSync(globalPath)) {
    const raw = readJson(globalPath);
    const validated = validateConfig(raw, globalPath);
    config = mergeConfigs(config, validated);
    foundGlobal = globalPath;
  }

  if (existsSync(projectPath)) {
    const raw = readJson(projectPath);
    const validated = validateConfig(raw, projectPath);
    config = mergeConfigs(config, validated);
    foundProject = projectPath;
  }

  return { config, globalPath: foundGlobal, projectPath: foundProject };
}

/** Returns true if `source` is a local filesystem path (not a URL or shorthand). */
export function isLocalSource(source: string): boolean {
  return source.startsWith("/") || source.startsWith("./") || source.startsWith("../");
}

/**
 * Normalise a `source` value to a clonable URL string.
 * - "github.com/org/repo" → "https://github.com/org/repo"
 * - "https://…"           → unchanged
 * - Local paths           → undefined (caller should use source as-is)
 */
export function toCloneUrl(source: string): string | undefined {
  if (isLocalSource(source)) return undefined;
  if (source.startsWith("https://") || source.startsWith("git@")) return source;
  // Bare "github.com/…" shorthand
  if (source.startsWith("github.com/")) return `https://${source}`;
  // Anything else: attempt as-is
  return source;
}
