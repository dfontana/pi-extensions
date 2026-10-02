---
name: bump-pi-version
description: >
  Bump this repo to a new pi version and re-verify the builtin-rows extension,
  which depends on pi internals. Use when pi warns "builtin-rows: pi X is
  unverified", or when upgrading the pi dev dependencies.
---

# Bump the pi version

`extensions/builtin-rows` re-registers pi's built-in tools, so it relies on two
pi internals: the options pi builds those tools with, and pi's renderer module.
It only applies on `VERIFIED_PI_VERSION`; on any other version it warns and
leaves pi's rendering alone.

## 1. Bump the dependencies

Set every `@earendil-works/pi-*` entry in `package.json` (devDependencies `^X`,
peerDependencies `>=X`) to the installed pi version (`pi --version`), then:

```bash
npm install --min-release-age=0   # ~/.npmrc delays new releases by 14 days
npm run typecheck
npm test
```

Fix any typecheck errors. In `extensions/builtin-rows/index.ts` they mean:

- **`knownOptions` fails:** a tool factory gained or lost an option. Go to step 2.
- **The `StockRendererModule` import fails:** pi moved or renamed
  `dist/core/tools/renderers/index.js` or its exports. Update the type import,
  the runtime path in `loadStockRenderers`, and the renderer lookup.

## 2. Check the tool options

Find where pi builds its own tools from settings:

```bash
rg -n -A6 "createAllToolDefinitions\(this._cwd" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
```

Compare the options passed there (today `read.autoResizeImages`,
`bash.commandPrefix`, and `bash.shellPath`) and the settings getters they use
(`dist/core/settings-manager.js`) with the `read` and `bash` objects in
builtin-rows' `session_start` handler. Mirror any new or changed option, and
update `knownOptions` to the new key sets.

## 3. Check the definitions still fit

builtin-rows spreads each `create*ToolDefinition` result and replaces only
`renderCall`/`renderResult`. Check that the overridden factories
(read, write, bash, grep, find, ls) still don't set `renderShell` and their
renderers don't depend on new context:

```bash
rg -n "renderShell|defaultActive" node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{read,write,bash,grep,find,ls}.js
```

## 4. Bump and smoke-test

Set `VERIFIED_PI_VERSION` to the new version, then run pi with the extension
and ask for one call to each overridden tool:

```bash
pi -e ./extensions/builtin-rows/index.ts --tools read,bash,write,ls,grep,find
```

**Pass:** there's no builtin-rows warning at startup. Each call is one
collapsed line (`read ✓ … path`, with long paths cut at the start). Ctrl+O
shows pi's own call and result rendering under each title, and a bash row
expanded after it finished shows the real duration ("Took 3.0s" for
`sleep 3`).
