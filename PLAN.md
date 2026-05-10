# Plan: Per-Plugin Enable/Disable for claude-marketplace

## Context

The `claude-marketplace` extension loads plugins from marketplace repos and injects their `skills/` directories via `resources_discover`. Users want to temporarily disable individual plugins — for example, to work on a local dev version of a plugin without having the remote version's skills active simultaneously.

Disabling a plugin must mean: after a `/reload`, that plugin's `skillPaths` are **not** returned in `resources_discover`. Re-enabling brings them back on the next reload.

Disabled-plugin state lives in the config file (`marketplace-config.json`). A new optional `disabledPlugins` field on each `MarketplaceEntry` lists plugin names that should not be injected. Both programmatic (TUI) and manual (text editor) edits are supported.

Write-back target rule when the TUI writes:
- Look up the marketplace entry in the project config (`<cwd>/.pi/marketplace-config.json`) first.
- If found there → update the project config.
- If only in the global config → update the global config.

Pull behaviour: disabled plugins still get git-pulled so the remote clone stays current regardless of which other plugins might use the same marketplace.

---

## Approach

Add `disabledPlugins?: string[]` to the `MarketplaceEntry` schema. Replace the bare `/marketplace` command's default behavior (which currently triggers an update) with a TUI that lists marketplaces and their plugins with enabled/disabled status. The TUI is built with `SettingsList` from `@earendil-works/pi-tui` and is opened via `ctx.ui.custom`. Toggling a plugin immediately writes back to the appropriate config file. Closing with Esc notifies the user to `/reload` if any changes were made.

### TUI layout
```
  Marketplace plugins  (Esc to close, Enter to toggle)
  ─────────────────────────────────────────────────
  my-marketplace                         (header, non-interactive)
    plugin-a                             enabled
    plugin-b                             disabled
  other-marketplace
    plugin-c                             enabled
```

- Marketplace names are non-interactive header rows (no `values`).
- Plugins are interactive rows with `values: ["enabled", "disabled"]`.
- No config → shows the existing no-config message via `ctx.ui.notify`, no TUI.
- Config parse error → shows the error message via `ctx.ui.notify`, no TUI.

## Files to modify

| File | Change |
|---|---|
| `extensions/claude-marketplace/config.ts` | Add `disabledPlugins` to `MarketplaceEntry`; add validation; add `updateDisabledPlugins` write-back helper |
| `extensions/claude-marketplace/fetcher.ts` | In `resolvePluginPaths`, skip plugins in `entry.disabledPlugins` |
| `extensions/claude-marketplace/index.ts` | Default path opens TUI; update `status` output; import `SettingsList` from `@earendil-works/pi-tui` |

## Reuse

- `readJson` / `validateEntry` / `validateConfig` in `config.ts` — extend for the new field, reuse the load path
- `resolvePluginPaths(entry)` in `fetcher.ts` — already receives the full `MarketplaceEntry`; reads `entry.disabledPlugins` directly, no signature change needed
- `SettingsList` from `@earendil-works/pi-tui` — the existing list component with label/value layout, cycles on Enter, Esc triggers `onCancel`
- `ctx.ui.custom` in `ExtensionUIContext` — opens the `SettingsList` as a full-screen TUI component
- `loadConfig` result carries `projectPath` / `globalPath` — use these to determine write-back target in `updateDisabledPlugins`
- Existing subcommand dispatch in `index.ts` — default path (no subcommand) now opens TUI instead of triggering update

## Steps

- [ ] **config.ts** — Add `disabledPlugins?: string[]` to `MarketplaceEntry` interface
- [ ] **config.ts** — Update `validateEntry` to parse and validate the optional `disabledPlugins` field (must be a string array; each name must be present in `plugins`)
- [ ] **config.ts** — Add `updateDisabledPlugins(marketplaceName, pluginName, action: 'disable' | 'enable', configPaths: { projectPath: string | null, globalPath: string | null })` helper: determines the right file (project if it has the entry, else global), reads raw JSON, updates `disabledPlugins` for the named marketplace entry, writes back as `JSON.stringify(..., null, 2) + "\n"`
- [ ] **fetcher.ts** — In `resolvePluginPaths`, skip any plugin name found in `entry.disabledPlugins ?? []`; add a `console.info` noting each skipped plugin
- [ ] **index.ts** — Add import for `SettingsList` and `SettingItem` from `@earendil-works/pi-tui`
- [ ] **index.ts** — Replace the default (`!subcommand`) path: if no config or config error, show existing notify messages; otherwise open the TUI via `ctx.ui.custom`
- [ ] **index.ts** — TUI factory: build `SettingItem[]` from the merged config — one non-interactive item per marketplace (id `"header:<name>"`, no `values`), one item per plugin (id `"plugin:<marketplace>:<plugin>"`, `values: ["enabled", "disabled"]`, `currentValue` from `disabledPlugins`)
- [ ] **index.ts** — `onChange` callback: parse the item id, call `updateDisabledPlugins`, track whether any changes occurred
- [ ] **index.ts** — `onCancel` callback: call `done(changed)` (boolean); after `await ctx.ui.custom(...)` returns, if `changed` notify user to `/reload`
- [ ] **index.ts** — Update `status` subcommand output to show each plugin's enabled/disabled state (reads from merged config's `disabledPlugins`)

## Verification

1. Configure a marketplace with two plugins in `marketplace-config.json`.
2. Run `/marketplace` (no args) — TUI opens showing both plugins as `enabled`.
3. Select a plugin, press Enter — status flips to `disabled`. Inspect the config file: `disabledPlugins: ["<plugin>"]` is present.
4. Press Esc — TUI closes, notification prompts `/reload`.
5. Run `/reload`, then run `/marketplace status` — disabled plugin marked, skill count reflects only the enabled plugin.
6. Open TUI again, re-enable the plugin, reload — skills return; `disabledPlugins` key removed from config.
7. With only a global config, confirm the global file is updated (not a project file).
8. With no config, confirm the TUI doesn’t open — the existing no-config message shows instead.
9. With a config parse error, confirm the error message shows instead of the TUI.
