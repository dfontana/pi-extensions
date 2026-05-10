# pi-extensions

Personal monorepo of [pi](https://github.com/earendil-works/pi-mono) extensions, themes, and skills.

## Structure

```
extensions/         # Auto-discovered .ts extension files (subdirs with index.ts)
themes/             # Auto-discovered .json theme files
skills/             # Auto-discovered SKILL.md folders
prompts/            # Auto-discovered .md prompt templates
```

## Install

```bash
pi install git:github.com/dfontana/pi-extensions
```

## Installed Packages

- npm:@tintinweb/pi-subagents
- npm:pi-web-access
- npm:@juicesharp/rpiv-ask-user-question
- npm:@tintinweb/pi-tasks
- npm:pi-notify
- npm:@plannotator/pi-extension
- git:github.com/dfontana/pi-extensions

## Contents

### Extensions

**improved-footer** — Replaces pi's default footer with:
- **jj bookmark support**: shows `jj:bookmark` instead of git branch, with git fallback and "(no vcs)" when neither is present
- **Accurate OpenRouter cost**: queries OpenRouter's `/api/v1/generation` API for actual response cost instead of pi's client-side estimation (which uses static pricing and doesn't account for OpenRouter's dynamic provider pricing)

**no-git-for-jj** — Blocks `git` commands when a `.jj/` directory is detected. Suggests the equivalent `jj` command instead.

**rainbow-spinner** — Custom working indicator: theme-colored braille spinner with a random whimsical phrase ("Pondering...", "Reticulating splines...", etc.) that changes each turn.

**claude-marketplace** — Pulls skills from Claude Code plugin marketplaces (e.g. `github.com/acme-corp/claude-marketplace`) and surfaces them in Pi. Configure which marketplaces and which specific plugins to install; repos are kept up-to-date automatically on a configurable schedule. Requires the [`gh` CLI](https://cli.github.com/) for repository access.

### Skills

**jujutsu** — Jujutsu version control workflow. Pre-work checklist, commit discipline rules, subagent restrictions, and a git→jj command reference.

### Themes

**rose-pine-dawn** — Rosé Pine Dawn theme — a warm, light theme with soft pastels.

---

## claude-marketplace Extension

### Requirements

- [`gh` CLI](https://cli.github.com/) must be installed and authenticated (`gh auth login`). Used for cloning and syncing GitHub marketplace repos.

### Config

Create `~/.pi/agent/marketplace-config.json` (global) and/or `.pi/marketplace-config.json` (project-local — merged on top of global):

```json
{
  "marketplaces": [
    {
      "name": "acme",
      "source": "github.com/acme-corp/claude-marketplace",
      "branch": "main",
      "plugins": ["dd", "metering", "lakehouse"]
    },
    {
      "name": "local-dev",
      "source": "/absolute/path/to/local/clone",
      "plugins": ["my-plugin"]
    }
  ],
  "updateIntervalHours": 24
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Unique key; used as the cache directory name. |
| `source` | string | — | `github.com/org/repo`, full HTTPS URL, or absolute local path. Local paths skip all git operations. |
| `branch` | string | `"main"` | Branch, tag, or commit to clone. Ignored for local paths. |
| `plugins` | string[] | — | Plugin names to install. Must match entries in the marketplace's `marketplace.json`. |
| `updateIntervalHours` | number | `24` | Hours between auto-pulls. Set to `0` to disable. |

**Merge behaviour:** project config's `marketplaces` entries replace global entries with the same `name`; novel names are appended. `updateIntervalHours` is overridden by the project config when present.

### How it works

1. **Startup**: Missing marketplace repos are cloned via `gh repo clone` (or `git clone` for non-GitHub URLs).
2. **Skill injection**: On every `resources_discover` event, Pi is given the `skills/` directories from all configured plugins. Skills appear alongside your local skills and behave identically.
3. **Auto-update**: On `session_start`, any marketplace whose last pull is older than `updateIntervalHours` is refreshed with `gh repo sync`. A footer status shows while the pull is running, and a notification prompts you to `/reload`.

### Commands

| Command | Description |
|---|---|
| `/marketplace update` | Force-pull all marketplaces immediately. |
| `/marketplace status` | Show each marketplace: source, last updated, plugins loaded, skill count. |
| `/marketplace list <name>` | List every plugin available in a marketplace (checkmark = currently configured). |

### What is and isn't supported

Claude Code plugins can contain several types of content. Only **skills** are surfaced in Pi:

| Content | Supported? | Notes |
|---|---|---|
| `skills/*/SKILL.md` | ✅ Yes | Injected via `resources_discover`; works like any local skill. |
| `agents/*.md` | ❌ No | Claude Code sub-agent definitions; no Pi equivalent. |
| `commands/` slash commands | ❌ No | Claude Code-specific (`/plugin:cmd` dispatch); no Pi equivalent. |
| `hooks/hooks.json` | ❌ No | Claude Code lifecycle hooks; different model from Pi events. |
| MCP server configs | ❌ No | Pi has no MCP layer. |

### Cache layout

```
~/.pi/agent/
  marketplace-cache/
    acme/               ← git clone of github.com/acme-corp/claude-marketplace
    …
  marketplace-state.json   ← last-updated timestamps
  marketplace-config.json  ← your global config
```

### Known limitations

- **Reload required after update**: After a `git pull` Pi must be restarted or `/reload` run for new/changed skills to take effect.
- **SSH auth**: The extension relies on `gh` CLI and git's ambient credential configuration. SSH key auth works as long as your `~/.gitconfig` and SSH agent are set up; no extra config needed.
- **Private non-GitHub repos**: Plain `git clone`/`git pull` is used. Ensure credentials are configured in your git credential helper.
- **Shallow clones**: Repos are cloned with `--depth=1` to minimise download size. If you need full history, clone manually and use a local `source` path.

---

## Future Ideas
- Custom output styles -- like "caveman", "cowboy", "noir", or other themes (playful or practical)
- modal/Helix-style input box extension
