# pi-extensions

Personal monorepo of [pi](https://github.com/earendil-works/pi-mono) extensions, themes, and skills.

## Structure

```
extensions/         # Auto-discovered .ts extension files (subdirs with index.ts)
themes/             # Auto-discovered .json theme files
skills/             # Auto-discovered SKILL.md folders
```

## Install

```bash
pi install git:github.com/dfontana/pi-extensions
```

## Extensions

Each extension has its own README covering configuration, provided tools/commands, and limitations.

| Extension | Purpose |
|---|---|
| [claude-marketplace](extensions/claude-marketplace/README.md) | Pull skills from Claude Code plugin marketplaces into Pi, auto-synced on a schedule |
| [helix-mode](extensions/helix-mode/README.md) | Helix-style modal editing for the input box (on by default; `/helix` to toggle) |
| [improved-footer](extensions/improved-footer/README.md) | Footer with jj bookmark support and accurate OpenRouter cost tracking |
| [mcp](extensions/mcp/README.md) | Lean MCP client: `.mcp.json` servers behind a single `mcp` proxy tool, `/mcp` panel |
| [no-git-for-jj](extensions/no-git-for-jj/README.md) | Blocks `git` commands in jj repos, suggesting the `jj` equivalent |
| [notify](extensions/notify/README.md) | Bell, desktop notification, and Zellij tab dot when Pi is ready for input |
| [pane-control](extensions/pane-control/README.md) | Multiplexing tools for opening, driving, reading, and closing Kitty or Zellij panes |
| [prompt-stash](extensions/prompt-stash/README.md) | Stash/restore the prompt editor with `Alt+Shift+S` |
| [rainbow-spinner](extensions/rainbow-spinner/README.md) | Theme-colored spinner with a random whimsical phrase each turn |
| [review-model-selector](extensions/review-model-selector/README.md) | `select_review_model` tool: deterministic adversarial-reviewer selection |
| [scoped-tools](extensions/scoped-tools/README.md) | JSON-specified bash commands as validated agent tools with hidden, call-time computed parameters |
| [web-access](extensions/web-access/README.md) | `web_search` and `web_fetch` tools backed by configurable model providers |

## Skills

- **run-review** — adversarial review/fix workflow over working changes, a branch, files, or revisions: parallel investigations, an independent high-thinking reviewer, and a bounded fix/re-review loop.
- **run-plan** — consolidates review feedback, delegates implementation to a persistent large-context agent, then invokes `run-review` with that implementer as the fixer.

A repo-local **web-access-smoke-test** skill (in `.pi/skills/`, not shipped with the package) provides an end-to-end check of the web-access tools after code changes.

`run-review` and `run-plan` require the separately installed `@tintinweb/pi-subagents` package; they preflight the `Agent` tools and return installation guidance rather than silently degrading.

```text
/skill:run-review
/skill:run-review scope=branch base=main thinking=xhigh
/skill:run-plan <review feedback and optional instructions>
```

## Themes

- **rose-pine-dawn** — Rosé Pine Dawn, a warm light theme with soft pastels.

## Installed Packages

- npm:@tintinweb/pi-subagents
- npm:@juicesharp/rpiv-ask-user-question
- npm:@tintinweb/pi-tasks
- npm:@plannotator/pi-extension
- git:github.com/dfontana/pi-extensions
