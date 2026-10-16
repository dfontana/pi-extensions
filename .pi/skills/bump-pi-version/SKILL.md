---
name: bump-pi-version
description: >
  Bump this repo's pi dev and peer dependencies to a new pi version and check
  the extensions still build and pass tests. Use when upgrading the pi
  dependencies.
---

# Bump the pi version

The extensions only use pi's public extension API, so a pi release breaks them
only through documented API changes. Check the `Breaking Changes` sections of
pi's `CHANGELOG.md` between the old and new versions.

## 1. Bump the dependencies

Set every `@earendil-works/pi-*` entry in `package.json` (devDependencies `^X`,
peerDependencies `>=X`) to the installed pi version (`pi --version`), then:

```bash
npm install --min-release-age=0   # ~/.npmrc delays new releases by 14 days
npm run typecheck
npm test
```

Fix any typecheck or test failures.

## 2. Smoke-test builtin-rows

builtin-rows wraps pi's stock renderers for the built-in tools. If pi stops
providing them, it falls back to pi's rendering without warning, so check it by
eye. Run pi with the extension and ask for one call to each wrapped tool:

```bash
pi -e ./extensions/builtin-rows/index.ts --tools read,bash,write,ls,grep,find
```

**Pass:** each call is one collapsed line (`read ✓ … path`, with long paths cut
at the start). Ctrl+O shows pi's own call and result rendering under each
title, and a bash row expanded after it finished shows the real duration
("Took 3.0s" for `sleep 3`).
