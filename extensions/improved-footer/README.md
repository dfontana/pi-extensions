# improved-footer

Replaces pi's default footer with one that shows the Jujutsu bookmark instead of the git branch (with git fallback) and tracks accurate OpenRouter costs via OpenRouter's generation API instead of pi's client-side estimate.

## Configuration

None. The OpenRouter API key is taken from pi's model registry (the `openrouter` provider), if configured.

## Provides

A replacement footer, mirroring pi's default layout:

```
~/cwd (jj:bookmark) • session-name
↑tokens ↓tokens CHhit% $cost ctx%/window        model $in/$out • thinking
extension statuses
```

- **VCS segment** — in a jj repo (detected via `jj root`), shows `jj:<bookmark>` for the nearest ancestor bookmark (`jj:??` when none); otherwise falls back to pi's git branch watcher; omitted when neither applies.
- **Cache hit (`CH`)** — the cache-read percentage for the latest assistant request, calculated from provider-reported usage; omitted until cache activity is reported.
- **Cost** — for OpenRouter responses, the actual cost is fetched from `https://openrouter.ai/api/v1/generation` per response id (pi's estimate uses static pricing and misses OpenRouter's dynamic provider pricing). Non-OpenRouter responses use pi's built-in cost. The two are summed into one `$` figure.
- **Model rates** — when the OpenRouter model catalog is available, the model name is annotated with its per-million-token prompt/completion prices.
- **Context %** — colored: warning above 70%, error above 90%.

## Limitations and Technical details

- Accurate OpenRouter cost requires an OpenRouter API key in the model registry; without one, OpenRouter responses contribute nothing to the cost figure (they are not estimated).
- Generation-cost lookups only happen for response ids starting with `gen-`, are deduplicated per id, and time out after 5s (a failed lookup is silently dropped).
- The jj bookmark is refreshed asynchronously on session start and after each assistant message, not on a file watcher — it can lag briefly after `jj` operations until the next agent activity.
- Token totals are backfilled from session entries on session restore.
