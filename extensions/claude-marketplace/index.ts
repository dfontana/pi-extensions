/**
 * claude-marketplace Pi Extension
 *
 * Pulls skills from Claude Code plugin marketplaces and surfaces them in Pi
 * via the `resources_discover` event.  Uses plain git for all clone/fetch
 * operations — no `gh` CLI dependency.
 *
 * Config files (both optional, project overrides global):
 *   ~/.pi/agent/marketplace-config.json
 *   <cwd>/<CONFIG_DIR_NAME>/marketplace-config.json
 *
 * On session start:
 *   1. Merge global + project configs.
 *   2. Start async clones for any marketplace repos not yet cached.
 *   3. Register a `resources_discover` handler that waits for clones then
 *      injects skill directories from every enabled plugin.
 *   4. Register a `session_start` handler that surfaces clone errors and
 *      triggers background stale pulls.
 *
 * Command:
 *   /marketplace   Open the marketplace manager TUI.
 *                  ↑↓ navigate · Enter: toggle plugin on/off
 *                  U: pull selected marketplace · Esc: close
 */

import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type LoadConfigResult,
  type MarketplaceConfig,
  type MarketplaceEntry,
  isLocalSource,
  loadConfig,
  piAgentDir,
  updateDisabledPlugins,
} from "./config.ts";
import { ensureCloned, forcePull, pullIfStale, resolvePluginPaths } from "./fetcher.ts";
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

/** Human-readable relative time, e.g. "3h ago". */
function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function noConfigMessage(): string {
  const globalPath = join(piAgentDir(), "marketplace-config.json");
  return (
    "No marketplaces configured.\n\n" +
    `Create ${globalPath} (global) or ${CONFIG_DIR_NAME}/marketplace-config.json (project) with:\n\n` +
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

export default function (pi: ExtensionAPI) {
  // The factory runs before the session context is available. Keep all
  // session-sensitive state lazy so project config is resolved from ctx.cwd,
  // not from the process that happened to load the extension.
  let config: MarketplaceConfig | null = null;
  let configError: string | null = null;
  let configPaths: Pick<LoadConfigResult, "projectPath" | "globalPath"> = {
    projectPath: null,
    globalPath: null,
  };
  let clonePromises = new Map<string, Promise<void>>();

  function initializeSession(cwd: string): void {
    config = null;
    configError = null;
    configPaths = { projectPath: null, globalPath: null };
    clonePromises = new Map();

    // A config error is non-fatal: we still register the command so the user
    // can see the error via /marketplace rather than a silent failure.
    try {
      const result = loadConfig(cwd);
      config = result.config;
      configPaths = { projectPath: result.projectPath, globalPath: result.globalPath };
    } catch (err: unknown) {
      configError = err instanceof Error ? err.message : String(err);
      return;
    }

    // Start clones only after the session context is available. Each remote
    // marketplace gets one shared Promise that resources_discover and the
    // session-start status/error reporting can await without re-running work.
    for (const entry of config.marketplaces) {
      if (isLocalSource(entry.source)) continue;
      clonePromises.set(entry.name, ensureCloned(entry, pi.exec));
    }
  }

  // ── resources_discover: inject skill paths ───────────────────────────────

  pi.on("resources_discover", async (_event, _ctx) => {
    const sessionConfig = config;
    const sessionClonePromises = clonePromises;
    if (!sessionConfig || sessionConfig.marketplaces.length === 0) return { skillPaths: [] };

    // Wait for all in-flight clones before resolving paths.  allSettled so
    // that a single failed clone doesn't prevent other repos from loading.
    if (sessionClonePromises.size > 0) {
      await Promise.allSettled(sessionClonePromises.values());
    }

    const { skillPaths, warnings } = resolveAllPaths(sessionConfig);
    for (const w of warnings) {
      console.warn(`[claude-marketplace] ${w}`);
    }
    return { skillPaths };
  });

  // ── session_start: surface errors + trigger stale pulls ──────────────────

  pi.on("session_start", async (_event, ctx) => {
    initializeSession(ctx.cwd);

    const sessionConfig = config;
    const sessionConfigError = configError;
    const sessionClonePromises = clonePromises;

    if (sessionConfigError) {
      ctx.ui.notify(`claude-marketplace: config error — ${sessionConfigError}`, "error");
    }

    // ── Await any in-progress initial clones and surface errors ──────────
    if (sessionClonePromises.size > 0) {
      (async () => {
        ctx.ui.setStatus("claude-marketplace", "↓ cloning marketplaces…");
        const results = await Promise.allSettled(sessionClonePromises.values());
        ctx.ui.setStatus("claude-marketplace", "");

        for (const result of results) {
          if (result.status === "rejected") {
            const msg = result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
            ctx.ui.notify(`claude-marketplace: ${msg}`, "error");
          }
        }
      })();
    }

    // ── Background stale-pull check ──────────────────────────────────────
    if (!sessionConfig || sessionConfig.marketplaces.length === 0 || sessionConfig.updateIntervalHours === 0) return;

    const remoteEntries = sessionConfig.marketplaces.filter((e) => !isLocalSource(e.source));
    if (remoteEntries.length === 0) return;
    const updateIntervalHours = sessionConfig.updateIntervalHours;

    (async () => {
      // Let the clone phase finish first so we don't race against a fresh checkout.
      if (sessionClonePromises.size > 0) {
        await Promise.allSettled(sessionClonePromises.values());
      }

      ctx.ui.setStatus("claude-marketplace", "↻ checking for marketplace updates…");

      const updated: string[] = [];
      const errors: string[] = [];

      for (const entry of remoteEntries) {
        try {
          const pulled = await pullIfStale(entry, updateIntervalHours, pi.exec);
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

  // ── /marketplace command ──────────────────────────────────────────────────

  pi.registerCommand("marketplace", {
    description: "Open the marketplace manager (toggle plugins, pull updates)",
    handler: async (_args, ctx) => {
      if (configError) {
        ctx.ui.notify(`Config error: ${configError}`, "error");
        return;
      }
      if (!config || config.marketplaces.length === 0) {
        ctx.ui.notify(noConfigMessage(), "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The marketplace manager is only available in TUI mode.", "warning");
        return;
      }

      // ── Build the row model ────────────────────────────────────────────
      type UpdateStatus = "idle" | "running" | "ok" | "fail";
      interface MarketplaceRow {
        kind: "marketplace";
        entry: MarketplaceEntry;
        updateStatus: UpdateStatus;
      }
      interface PluginRow {
        kind: "plugin";
        entry: MarketplaceEntry;
        name: string;
        enabled: boolean;
      }
      type Row = MarketplaceRow | PluginRow;

      const rows: Row[] = [];
      for (const entry of config.marketplaces) {
        rows.push({ kind: "marketplace", entry, updateStatus: "idle" });
        const disabledSet = new Set(entry.disabledPlugins ?? []);
        for (const name of entry.plugins) {
          rows.push({ kind: "plugin", entry, name, enabled: !disabledSet.has(name) });
        }
      }

      // ── Open the TUI ──────────────────────────────────────────────────
      const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

      const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
        let cursor = 0;
        let dirty = false;
        let spinnerFrame = 0;
        let spinnerTimer: ReturnType<typeof setInterval> | null = null;
        const errors: string[] = [];

        function startSpinner() {
          if (spinnerTimer !== null) return;
          spinnerTimer = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            tui.requestRender();
          }, 80);
        }

        function stopSpinnerIfIdle() {
          if (rows.some((r) => r.kind === "marketplace" && r.updateStatus === "running")) return;
          if (spinnerTimer !== null) {
            clearInterval(spinnerTimer);
            spinnerTimer = null;
          }
        }

        return {
          invalidate() {},

          dispose() {
            if (spinnerTimer !== null) {
              clearInterval(spinnerTimer);
              spinnerTimer = null;
            }
          },

          render(width: number): string[] {
            const lines: string[] = [];

            // ── Hint ──────────────────────────────────────────────────
            const currentRow = rows[cursor];
            const hint = currentRow?.kind === "marketplace"
              ? "↑↓ navigate  ·  U: pull this marketplace  ·  Esc: close"
              : "↑↓ navigate  ·  Enter: toggle plugin on/off  ·  U: pull marketplace  ·  Esc: close";
            lines.push(theme.fg("dim", hint));
            lines.push(theme.fg("borderMuted", "─".repeat(width)));

            // ── Errors ────────────────────────────────────────────────
            for (const err of errors) {
              // Word-wrap long errors to width
              const prefix = "  ✗ ";
              const maxLen = width - prefix.length;
              const chunks: string[] = [];
              for (let i = 0; i < err.length; i += maxLen) {
                chunks.push(err.slice(i, i + maxLen));
              }
              for (const chunk of chunks) {
                lines.push(theme.fg("error", prefix + chunk));
              }
            }

            // ── Rows ──────────────────────────────────────────────────
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const selected = i === cursor;
              const cursorGlyph = selected ? theme.fg("accent", "›") : " ";

              if (row.kind === "marketplace") {
                // Status badge on the right
                let badge = "";
                if (row.updateStatus === "running") {
                  badge = " " + theme.fg("accent", SPINNER[spinnerFrame]);
                } else if (row.updateStatus === "ok") {
                  badge = " " + theme.fg("success", "✓");
                } else if (row.updateStatus === "fail") {
                  badge = " " + theme.fg("error", "✗");
                }

                const lu = lastUpdated(row.entry.name);
                const age = lu && !isLocalSource(row.entry.source)
                  ? theme.fg("dim", ` (${relativeTime(lu)})`)
                  : "";

                const label = selected
                  ? theme.fg("accent", row.entry.name)
                  : theme.bold(row.entry.name);

                // Compose: "› label (age)   badge"
                const rawLabel = row.entry.name;
                const rawAge = lu && !isLocalSource(row.entry.source) ? ` (${relativeTime(lu)})` : "";
                const badgeW = badge ? 2 : 0; // space + glyph
                const pad = Math.max(1, width - 2 - rawLabel.length - rawAge.length - badgeW);
                lines.push(`${cursorGlyph} ${label}${age}${" ".repeat(pad)}${badge}`);
              } else {
                // Plugin row
                const valueRaw = row.enabled ? "enabled" : "disabled";
                const valueStr = row.enabled
                  ? theme.fg("success", valueRaw)
                  : theme.fg("dim", valueRaw);

                const rawLabel = `    ${row.name}`;
                const label = selected
                  ? theme.fg("accent", rawLabel)
                  : theme.fg(row.enabled ? "text" : "dim", rawLabel);

                const pad = Math.max(1, width - 2 - rawLabel.length - valueRaw.length);
                lines.push(`${cursorGlyph} ${label}${" ".repeat(pad)}${valueStr}`);
              }
            }

            return lines;
          },

          handleInput(data: string) {
            // ── Navigation ──────────────────────────────────────────
            if (matchesKey(data, Key.up)) {
              cursor = Math.max(0, cursor - 1);
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.down)) {
              cursor = Math.min(rows.length - 1, cursor + 1);
              tui.requestRender();
              return;
            }

            // ── Esc: close ──────────────────────────────────────────
            if (matchesKey(data, Key.escape)) {
              done(dirty);
              return;
            }

            // ── Enter: toggle plugin ─────────────────────────────────
            if (matchesKey(data, Key.enter)) {
              const row = rows[cursor];
              if (row?.kind !== "plugin") return;

              const next = !row.enabled;
              row.enabled = next;
              try {
                updateDisabledPlugins(
                  row.entry.name,
                  row.name,
                  next ? "enable" : "disable",
                  configPaths,
                );
                dirty = true;
              } catch (err: unknown) {
                // Revert the in-memory toggle on write failure
                row.enabled = !next;
                errors.push(err instanceof Error ? err.message : String(err));
              }
              tui.requestRender();
              return;
            }

            // ── U: pull marketplace ──────────────────────────────────
            if (data === "u" || data === "U") {
              const row = rows[cursor];
              if (row?.kind !== "marketplace") return;
              if (row.updateStatus === "running") return;
              if (isLocalSource(row.entry.source)) return;

              row.updateStatus = "running";
              startSpinner();
              tui.requestRender();

              forcePull(row.entry, pi.exec)
                .then(() => {
                  row.updateStatus = "ok";
                  stopSpinnerIfIdle();
                  tui.requestRender();
                })
                .catch((err: unknown) => {
                  row.updateStatus = "fail";
                  errors.push(err instanceof Error ? err.message : String(err));
                  stopSpinnerIfIdle();
                  tui.requestRender();
                });
              return;
            }
          },
        };
      });

      if (changed) {
        ctx.ui.notify(
          "Plugin visibility updated. Run /reload to apply changes.",
          "info",
        );
      }
    },
  });
}
