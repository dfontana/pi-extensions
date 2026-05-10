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

| Package | Source |
|---------|--------|
| @tintinweb/pi-subagents | npm |
| pi-web-access | npm |
| @juicesharp/rpiv-ask-user-question | npm |
| @juicesharp/rpiv-todo | npm |
| dfontana/pi-extensions | git |
| pi-notify | npm |

## Contents

### Extensions

**jj-bookmark** — Shows the current jujutsu bookmark (or git branch) in the pi footer. Falls back to git if not in a jj repo.

**no-git-for-jj** — Blocks `git` commands when a `.jj/` directory is detected. Suggests the equivalent `jj` command instead.

### Skills

**jujutsu** — Jujutsu version control workflow. Pre-work checklist, commit discipline rules, subagent restrictions, and a git→jj command reference.

### Themes

**rose-pine-dawn** — Rosé Pine Dawn theme — a warm, light theme with soft pastels.