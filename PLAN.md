# Plan: Claude Marketplace Support for Pi

## Context

Pi doesn't natively support Claude Code plugin marketplaces, but your company uses them extensively (e.g., `github.com/acme-corp/claude-marketplace`). Claude marketplaces are Git repos where each subdirectory is a plugin containing skills, agents, commands, and hooks.

The goal is a Pi extension that:
1. Reads a config of which marketplaces to pull from and which plugins to install
2. Makes the compatible content (primarily skills) available to Pi automatically
3. Periodically refreshes marketplace repos from upstream

## Claude Marketplace Structure (Research)

A marketplace repo has:
- **`.claude-plugin/marketplace.json`** — lists all plugins with `{ name, source }` entries
- **`<plugin>/.claude-plugin/plugin.json`** — plugin metadata (name, description, author)
- **`<plugin>/skills/*/SKILL.md`** — skill definitions (Agent Skills standard)
- **`<plugin>/agents/*.md`** — Claude Code sub-agent definitions (frontmatter + markdown)
- **`<plugin>/commands/` or `commands.md`** — Claude Code slash commands (`/plugin:cmd` format)
- **`<plugin>/hooks/hooks.json`** — Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, etc.)

## Compatibility Analysis

| Marketplace Content | Pi Support | Notes |
|---|---|---|
| `skills/*/SKILL.md` | ✅ Full | Agent Skills standard; Pi loads these natively via `resources_discover` |
| `agents/*.md` | ⚠️ Partial | Can inject as Pi prompt templates. Frontmatter (model, color) is ignored. |
| `commands/` slash commands | ❌ Not supported | Claude Code-specific format (`/plugin:cmd`); Pi commands use a different API |
| `hooks/hooks.json` | ❌ Not supported | Claude Code lifecycle hooks don't map to Pi's event system |
| MCP server configs | ❌ Not supported | Pi doesn't support MCP |
| Plugin metadata (`plugin.json`) | ℹ️ Informational only | Used to validate plugin exists; not loaded into Pi |

**What this extension will deliver:** Skills from configured plugins are surfaced in Pi exactly as if locally installed. Agent definitions are adapted as prompt templates (invocable via `/templatename`). Commands and hooks are explicitly skipped.

## Approach

A Pi extension (`extensions/claude-marketplace/`) that:

1. **Reads config** from `~/.pi/agent/marketplace-config.json` (global) and/or `.pi/marketplace-config.json` (project-local, merged/overrides global)
2. **Clones/pulls** marketplace repos into `~/.pi/agent/marketplace-cache/<marketplace-name>/` using `git`
3. **Injects skills** from configured plugins via the `resources_discover` event
4. **Adapts agents** from configured plugins as Pi prompt templates (optional, configurable)
5. **Tracks update timestamps** in `~/.pi/agent/marketplace-state.json` and refreshes stale marketplaces on `session_start`

## Config File Format

`~/.pi/agent/marketplace-config.json` (global) or `.pi/marketplace-config.json` (project override):

```json
{
  "marketplaces": [
    {
      "name": "acme",
      "source": "github.com/acme-corp/claude-marketplace",
      "branch": "main",
      "auth": "${GITHUB_TOKEN}",
      "plugins": ["dd", "metering", "lakehouse"]
    },
    {
      "name": "local-dev",
      "source": "/absolute/path/to/local/claude-marketplace",
      "plugins": ["my-plugin"]
    }
  ],
  "updateIntervalHours": 24,
  "adaptAgents": true
}
```

Fields:
- `source`: GitHub shorthand (`github.com/org/repo`), full HTTPS URL, or local absolute path. Local paths skip git operations and are never "updated."
- `auth`: Optional env var reference (`${VAR}`) used as `Authorization: token <val>` for git clone/pull over HTTPS. Omit for public repos.
- `plugins`: Array of plugin names to install. These must match entries in the marketplace's `marketplace.json`.
- `branch`: Optional branch/tag/commit. Defaults to `main`.
- `updateIntervalHours`: How often to `git pull`. Defaults to `24`. Set to `0` to disable auto-update.
- `adaptAgents`: Whether to surface `agents/*.md` as Pi prompt templates. Defaults to `true`.

## Cache & State Layout

```
~/.pi/agent/
  marketplace-cache/
    acme/               ← git clone of github.com/acme-corp/claude-marketplace
      dd/skills/…
      metering/skills/…
      …
  marketplace-state.json   ← { "acme": { "lastUpdated": "2025-01-01T00:00:00Z" } }
  marketplace-config.json  ← user's global config
```

## Files to Modify / Create

| File | Action |
|---|---|
| `extensions/claude-marketplace/index.ts` | Main extension entry point |
| `extensions/claude-marketplace/config.ts` | Config loading & merging (global + project) |
| `extensions/claude-marketplace/fetcher.ts` | git clone/pull logic, marketplace.json validation |
| `extensions/claude-marketplace/state.ts` | Read/write `marketplace-state.json` |
| `extensions/claude-marketplace/package.json` | Declare as Pi package (`"pi": { "extensions": … }`) |
| `README.md` | Document the new extension |

## Reuse

- Pi extension event API: `resources_discover` (inject skill paths), `session_start` (trigger update check) — from `@earendil-works/pi-coding-agent`
- Node.js builtins: `child_process.execSync` (git), `fs`, `path`
- Existing pattern: `extensions/improved-footer/index.ts` — shows async factory, `ctx.ui.setStatus`, session lifecycle events

## Implementation Steps

- [ ] **1. Create `extensions/claude-marketplace/package.json`** — Pi package manifest pointing to `index.ts`
- [ ] **2. Implement `config.ts`** — load and deep-merge global + project config files; validate schema; expand `${ENV_VAR}` in `auth`
- [ ] **3. Implement `state.ts`** — read/write last-update timestamps from `marketplace-state.json` in the Pi agent dir
- [ ] **4. Implement `fetcher.ts`**:
  - `ensureCloned(marketplace)`: `git clone <url>` into cache dir if not present; handle `auth` via `GIT_ASKPASS` env var pattern
  - `pullIfStale(marketplace, state)`: `git pull` if `(now - lastUpdated) > updateIntervalHours`; update state after success
  - `resolvePluginPaths(marketplaceCacheDir, pluginNames)`: read `marketplace.json`, validate requested plugins exist, return `{ skillPaths, promptPaths }` for each
- [ ] **5. Implement `index.ts` (async factory)**:
  - Load config on startup; if no config, exit silently
  - Call `ensureCloned` for each marketplace (blocking startup — user sees a brief "Fetching marketplace…" status)
  - Register `resources_discover` handler: return skill paths (and prompt paths for agents if `adaptAgents`)
  - Register `session_start` handler: call `pullIfStale` async (non-blocking, show status indicator while running, clear on done)
  - Register `/marketplace` command: manual `update`, `list`, `status` subcommands
- [ ] **6. Add `/marketplace` command** with subcommands:
  - `/marketplace update` — force-pull all marketplaces now
  - `/marketplace status` — show each marketplace: name, last updated, plugins loaded
  - `/marketplace list <marketplace-name>` — list all available plugins in a marketplace's `marketplace.json`
- [ ] **7. Update `README.md`** — document config format, limitations, and usage

## Known Limitations (Out of Scope)

- **Commands not supported**: Claude Code slash commands (`commands/`, `commands.md`) use a `markdown-as-prompt` format tied to Claude Code's `/plugin:cmd` dispatch. There's no Pi equivalent for this structure.
- **Hooks not supported**: `hooks/hooks.json` maps to Claude Code's `SessionStart`, `UserPromptSubmit`, etc. — not Pi's extension event model.
- **Agents are partial**: `agents/*.md` files contain Claude Code sub-agent definitions with Claude-specific frontmatter (`model`, `color`, `tools`). The extension surfaces only the markdown body as a Pi prompt template; the sub-agent invocation mechanism is absent.
- **MCP servers**: Not supported — Pi has no MCP layer.
- **Auth for private repos**: Only HTTPS token auth is supported. SSH key auth relies on git's ambient credential handling (i.e., whatever your `~/.gitconfig` is set up for).
- **No live reload for fetched content**: After `git pull`, Pi must be restarted (or `/reload` run) for new/updated skills to take effect.

## Verification

1. Create `~/.pi/agent/marketplace-config.json` with a public marketplace
2. Start Pi — verify git clone happens on first run, status indicator shows progress
3. Run `/skill` list — verify skills from configured plugins appear
4. Wait for (or manually trigger with `/marketplace update`) a refresh — verify `git pull` runs
5. Verify project-local `.pi/marketplace-config.json` overrides global config
6. Verify that a missing/invalid plugin name emits a warning but doesn't crash Pi
7. Verify that a local path source works without any git operations
