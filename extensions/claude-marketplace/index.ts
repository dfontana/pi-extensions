/**
 * claude-marketplace Pi Extension
 *
 * Pulls skills from Claude Code plugin marketplaces and surfaces them in Pi
 * via the `resources_discover` event.  Requires the `gh` CLI for cloning and
 * syncing GitHub repositories.
 *
 * Config files (both optional, project overrides global):
 *   ~/.pi/agent/marketplace-config.json
 *   <cwd>/.pi/marketplace-config.json
 *
 * On startup:
 *   1. Merge global + project configs.
 *   2. Clone any marketplace repos that haven't been fetched yet (blocking).
 *   3. Register a `resources_discover` handler that injects skill directories
 *      from every configured plugin.
 *   4. Register a `session_start` handler that pulls stale repos and shows a
 *      brief status line while running.
 *
 * Commands (always registered, even with no config):
 *   /marketplace update          Force-pull all marketplaces now.
 *   /marketplace status          Show last-updated time and loaded plugins.
 *   /marketplace list <name>     List all available plugin names in a marketplace.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type MarketplaceConfig, type MarketplaceEntry, isLocalSource, loadConfig, piAgentDir } from "./config.ts";
import { ensureCloned, forcePull, marketplaceCacheDir, pullIfStale, resolvePluginPaths } from "./fetcher.ts";
import { lastUpdated } from "./state.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAllPaths(config: MarketplaceConfig): { skillPaths: string[]; warnings: string[] } {
  const skillPaths: string[] = [];
  const warnings: string[] = [];
  for (const entry of config.marketplaces) {
    const result = resolvePluginPaths(entry);
    skillPaths.push(...result.skillPaths);
    warnings.push(...result.warnings);
  }
  return { skillPaths, warnings };
}

/** Human-readable relative time, e.g. "3 hours ago". */
function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Read available plugin names from a marketplace's marketplace.json. */
function listAvailablePlugins(entry: MarketplaceEntry): string[] {
  const marketplaceRoot = isLocalSource(entry.source)
    ? resolve(entry.source)
    : marketplaceCacheDir(entry.name);

  const jsonPath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(jsonPath)) {
    throw new Error(`marketplace.json not found at ${jsonPath}`);
  }

  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as { plugins: Array<{ name: string }> };
  return (raw.plugins ?? []).map((p) => p.name).sort();
}

function noConfigMessage(): string {
  const globalPath = join(piAgentDir(), "marketplace-config.json");
  return (
    "No marketplaces configured.\n\n" +
    `Create ${globalPath} (global) or .pi/marketplace-config.json (project) with:\n\n` +
    '{\n' +
    '  "marketplaces": [\n' +
    '    {\n' +
    '      "name": "my-marketplace",\n' +
    '      "source": "github.com/org/repo",\n' +
    '      "plugins": ["plugin-a", "plugin-b"]\n' +
    '    }\n' +
    '  ]\n' +
    '}'
  );
}

// ─── Extension factory ────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ── Load config ──────────────────────────────────────────────────────────
  // A config error is non-fatal: we still register the command so the user
  // can see the error via /marketplace status rather than a silent failure.

  let config: MarketplaceConfig | null = null;
  let configError: string | null = null;

  try {
    const result = loadConfig(cwd);
    config = result.config;
  } catch (err: unknown) {
    configError = err instanceof Error ? err.message : String(err);
  }

  // ── Clone missing marketplace repos (blocking, runs before events fire) ──

  const cloneErrors: string[] = [];

  if (config && config.marketplaces.length > 0) {
    for (const entry of config.marketplaces) {
      if (isLocalSource(entry.source)) continue;
      try {
        ensureCloned(entry);
      } catch (err: unknown) {
        cloneErrors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ── resources_discover: inject skill paths ───────────────────────────────

  pi.on("resources_discover", async (_event, _ctx) => {
    if (!config || config.marketplaces.length === 0) return { skillPaths: [] };
    const { skillPaths, warnings } = resolveAllPaths(config);
    for (const w of warnings) {
      console.warn(`[claude-marketplace] ${w}`);
    }
    return { skillPaths };
  });

  // ── session_start: surface errors + trigger stale pulls ──────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (configError) {
      ctx.ui.notify(`claude-marketplace: config error — ${configError}`, "error");
    }
    for (const err of cloneErrors) {
      ctx.ui.notify(`claude-marketplace: ${err}`, "error");
    }

    if (!config || config.marketplaces.length === 0 || config.updateIntervalHours === 0) return;

    const remoteEntries = config.marketplaces.filter((e) => !isLocalSource(e.source));
    if (remoteEntries.length === 0) return;

    (async () => {
      ctx.ui.setStatus("claude-marketplace", "↻ checking for marketplace updates…");
      await new Promise((r) => setTimeout(r, 0));

      const updated: string[] = [];
      const errors: string[] = [];

      for (const entry of remoteEntries) {
        try {
          const pulled = pullIfStale(entry, config!.updateIntervalHours);
          if (pulled) updated.push(entry.name);
        } catch (err: unknown) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      ctx.ui.setStatus("claude-marketplace", "");

      for (const e of errors) {
        ctx.ui.notify(`claude-marketplace: ${e}`, "error");
      }
      if (updated.length > 0) {
        ctx.ui.notify(
          `claude-marketplace: updated ${updated.join(", ")}. Run /reload to pick up new skills.`,
          "info",
        );
      }
    })();
  });

  // ── /marketplace command (always registered) ──────────────────────────────

  pi.registerCommand("marketplace", {
    description: "Manage Claude marketplace plugins: update | status | list <marketplace>",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/);

      // ── update ────────────────────────────────────────────────────────────
      if (!subcommand || subcommand === "update") {
        if (!config || config.marketplaces.length === 0) {
          ctx.ui.notify(noConfigMessage(), "info");
          return;
        }

        ctx.ui.setStatus("claude-marketplace", "↻ pulling all marketplaces…");
        const results: string[] = [];

        for (const entry of config.marketplaces) {
          if (isLocalSource(entry.source)) {
            results.push(`  ${entry.name}: local path, skipped`);
            continue;
          }
          try {
            ensureCloned(entry);
            forcePull(entry);
            results.push(`  ${entry.name}: ✓ updated`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`  ${entry.name}: ✗ ${msg}`);
          }
        }

        ctx.ui.setStatus("claude-marketplace", "");
        ctx.ui.notify(
          `claude-marketplace update\n${results.join("\n")}\n\nRun /reload to apply changes.`,
          "info",
        );
        return;
      }

      // ── status ────────────────────────────────────────────────────────────
      if (subcommand === "status") {
        if (configError) {
          ctx.ui.notify(`Config error: ${configError}`, "error");
          return;
        }
        if (!config || config.marketplaces.length === 0) {
          ctx.ui.notify(noConfigMessage(), "info");
          return;
        }

        const lines: string[] = ["Claude Marketplace Status", "─".repeat(40)];
        lines.push(`Update interval: ${config.updateIntervalHours === 0 ? "disabled" : `every ${config.updateIntervalHours}h`}`);
        lines.push("");

        for (const entry of config.marketplaces) {
          const lu = lastUpdated(entry.name);
          const when = isLocalSource(entry.source)
            ? "(local path)"
            : lu ? relativeTime(lu) : "never";

          lines.push(entry.name);
          lines.push(`  source:   ${entry.source}`);
          lines.push(`  plugins:  ${entry.plugins.join(", ")}`);
          lines.push(`  updated:  ${when}`);

          const { skillPaths, warnings } = resolvePluginPaths(entry);
          let totalSkills = 0;
          for (const sp of skillPaths) {
            if (existsSync(sp)) {
              totalSkills += readdirSync(sp, { withFileTypes: true })
                .filter((d) => d.isDirectory()).length;
            }
          }
          lines.push(`  skills:   ${totalSkills} loaded`);
          for (const w of warnings) lines.push(`  ⚠ ${w}`);
          lines.push("");
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── list ──────────────────────────────────────────────────────────────
      if (subcommand === "list") {
        if (!config || config.marketplaces.length === 0) {
          ctx.ui.notify(noConfigMessage(), "info");
          return;
        }

        const target = rest.join(" ").trim();
        if (!target) {
          ctx.ui.notify(
            "Usage: /marketplace list <marketplace-name>\n\nConfigured: " +
            config.marketplaces.map((m) => m.name).join(", "),
            "info",
          );
          return;
        }

        const entry = config.marketplaces.find((m) => m.name === target);
        if (!entry) {
          ctx.ui.notify(
            `Unknown marketplace "${target}". Configured: ${config.marketplaces.map((m) => m.name).join(", ")}`,
            "error",
          );
          return;
        }

        if (!isLocalSource(entry.source)) {
          try {
            ensureCloned(entry);
          } catch (err: unknown) {
            ctx.ui.notify(`Failed to access "${target}": ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
          }
        }

        try {
          const plugins = listAvailablePlugins(entry);
          const installed = new Set(entry.plugins);
          ctx.ui.notify([
            `Available plugins in "${target}" (${plugins.length} total):`,
            `Configured: ${entry.plugins.join(", ")}`,
            "─".repeat(40),
            ...plugins.map((p) => `  ${installed.has(p) ? "✓" : " "} ${p}`),
          ].join("\n"), "info");
        } catch (err: unknown) {
          ctx.ui.notify(`Failed to list plugins for "${target}": ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── unknown subcommand ────────────────────────────────────────────────
      ctx.ui.notify(
        `Unknown subcommand "${subcommand}". Usage:\n` +
        "  /marketplace update          Pull all marketplaces now\n" +
        "  /marketplace status          Show status and loaded skills\n" +
        "  /marketplace list <name>     List available plugins in a marketplace",
        "error",
      );
    },
  });
}
