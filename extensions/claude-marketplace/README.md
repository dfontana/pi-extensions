# claude-marketplace

Pulls skills from Claude Code plugin marketplaces (e.g. `github.com/acme-corp/claude-marketplace`) and surfaces them in Pi alongside your local skills. Repos are cloned to a local cache and kept up to date on a configurable schedule.

## Configuration

`getAgentDir()/marketplace-config.json` (global; by default `~/.pi/agent/marketplace-config.json`) and/or `<CONFIG_DIR_NAME>/marketplace-config.json` (project — merged on top of global; `CONFIG_DIR_NAME` comes from pi):

```jsonc
{
  "marketplaces": [
    {
      "name": "acme",                                 // string, required
      "source": "github.com/acme-corp/marketplace",   // string, required
      "branch": "main",                               // string, default "main"
      "plugins": ["thing"],                           // string[], required
      "disabledPlugins": ["other_thing"]              // string[], optional
    }
  ],
  "updateIntervalHours": 24                           // number, default 24; 0 = never
}
```

The minimum configuration is:

```json
{
  "marketplaces": [
    { "name": "acme", "source": "github.com/acme-corp/marketplace", "plugins": ["thing"] }
  ]
}
```

### Configuration Details

- `name` — unique, non-empty; used as the cache directory name. Duplicate names within one file are rejected.
- `source` — non-empty string, one of: GitHub shorthand `github.com/org/repo` (converted to HTTPS), full `https://` URL, SSH URL `git@github.com:org/repo.git` (preferred for private repos), or an absolute/relative local path. Local paths are used in place and skip all git operations.
- `branch` — branch, tag, or commit passed to `git clone --branch`. Ignored for local sources.
- `plugins` — non-empty array of non-empty strings; each must match a plugin `name` in the marketplace's `.claude-plugin/marketplace.json`, otherwise a warning is logged and the plugin is skipped.
- `disabledPlugins` — must be a subset of `plugins`. Disabled plugins are excluded from skill discovery but still pulled during sync. Managed for you by the `/marketplace` TUI, which writes back to the config file the entry lives in (project preferred over global).
- `updateIntervalHours` — non-negative number; hours between automatic background pulls at session start.
- Merge behavior: project entries replace global entries with the same `name`; novel names are appended. `updateIntervalHours` from the project config wins when present.
- A config error is non-fatal: it is surfaced as a notification and via `/marketplace` instead of silently disabling the extension.

## Provides

- `/marketplace` — manager TUI: `↑↓` navigate · `Enter` toggle a plugin on/off · `U` pull the selected marketplace · `Esc` close. Toggles require `/reload` to take effect.
- Skill injection — every enabled plugin's `skills/` directory is injected on resource discovery; skills behave exactly like local ones.

## Special Setup Instructions

- Requires `git` on PATH. Authentication uses git's own credential stack (SSH keys, credential helpers, `.netrc`) — there is no `gh` CLI dependency. For private repos, prefer an SSH `source`.

## Limitations and Technical details

- Cache layout under `~/.pi/agent/` (respects `PI_CODING_AGENT_DIR`):
  - `marketplace-cache/<name>/` — shallow clone of each remote marketplace
  - `marketplace-state.json` — last-updated timestamps
- Clones are `--depth=1`; updates run `git fetch --depth=1 && git reset --hard FETCH_HEAD`, so any local edits inside the cache are discarded. If you need full history or local edits, clone manually and use a local `source`.
- Only **skills** (`skills/*/SKILL.md`) are surfaced. Claude Code `agents/`, `commands/`, `hooks/`, and MCP server configs have no Pi equivalent and are ignored.
- After a background update or plugin toggle, run `/reload` (or restart Pi) to pick up changes.
- Plugin `source` paths inside `marketplace.json` that resolve outside the marketplace root are skipped (path-traversal guard, mirroring Claude Code's installer).
