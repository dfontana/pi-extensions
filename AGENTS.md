# Repository Guidelines

## Development

```bash
npm install        # repo-level dev dependencies
npm test           # TypeScript unit tests (Node built-in runner)
npm run typecheck  # TypeScript type-checking
```

## Testing extensions

Tests should protect an extension's observable contract while allowing its implementation to evolve.

- Prefer tests of the extension plugin interface and user-visible system behavior. Use unit tests for exported adapters or helpers only when they define a real boundary (for example, a provider wire format).
- Avoid asserting incidental implementation details such as private helper calls, intermediate state, or exact command construction. Assert exact request shapes only at an external provider or process boundary where that shape is the contract.
- Favor data-driven cases over many near-identical tests. Keep distinct tests only for meaningfully different behaviors or failure modes.
- Write assertions that remain valid after an implementation refactor, while preserving important outcomes, validation, error handling, and compatibility guarantees.
- Group test output by extension. A file-level suite must be named `{plugin} {file}` (for example, `web-access web-fetch`). Use only `{plugin}` when the suite tests that extension's plugin interface directly; prefer such interface coverage where practical.
- Run `npm test` and `npm run typecheck` after modifying tests.
