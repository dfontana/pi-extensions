---
name: web-access-smoke-test
description: >
  Smoke-test the web_search and web_fetch tools in the web-access extension
  after making code changes. Run both tools against known-good endpoints to
  confirm requests reach the provider and content is returned.
---

# web-access Smoke Test

Run these two tool calls in order and verify the expected outcomes.

## 1. web_search

```json
{
  "query": "kitty set user variable from program escape code OSC",
  "max_results": 6,
  "allowed_domains": ["sw.kovidgoyal.net", "github.com"],
  "search_context_size": "high"
}
```

**Pass:** Returns a text summary with at least one `sw.kovidgoyal.net` citation. No provider error.

> With `search.provider: "openai-codex"` the backend emits no annotations, so
> expect an on-topic summary (kitty user variables / remote control) with zero
> Sources entries — that is a pass, not a failure.

## 2. web_fetch

```
url: https://nill.ink/frontier/
```

**Pass:** Returns the full page — visible blog post titles such as "Integration Tests with Karate" and "Creating a Discord Bot in Rust". No provider error, no redirect stub.

> Use `https://nill.ink/frontier/` (not the kitty docs) because kitty's docs
> site uses a JS redirect that web_fetch can't follow, which would give a false
> failure signal.

## What to look for in failures

| Symptom | Likely cause |
|---|---|
| 404 `Unknown compliance rule for api: /messages` | `anthropicAdapter.endpoint()` is missing `/v1/` — see `web-fetch.ts` |
| 404 on `/responses` | `baseUrl` for the OpenAI provider lost its `/v1` suffix |
| 404 `Model not found <id>` (openai-codex) | pi's registry lists ids the ChatGPT backend doesn't serve (e.g. `gpt-5.6-luna`) — switch to one it does (`gpt-5.5`) |
| 403 Cloudflare HTML (openai-codex) | Request missing codex-client headers — see `openaiCodexAdapter.headers()` in `providers.ts` |
| Empty content / redirect stub | Normal for JS-rendered pages; not a tool bug |
