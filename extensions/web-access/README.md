# web-access

Gives the pi agent two tools backed by a configured model provider: `web_search` (web search via an OpenAI-style Responses API) and `web_fetch` (fetch a URL's text content via a server-side fetch tool). Each tool has its own provider/model, so search and fetch can be served by different providers.

## Configuration

`~/.pi/agent/web-access.json` (global) with `./.pi/web-access.json` (project) merged on top — scalars override, `search`/`fetch` sections merge key-by-key, `providerParams` merge per provider key.

```jsonc
{
  "search": {                          // web_search — omit to disable
    "provider": "openai",              // string, required
    "model": "gpt-5.5",                // string, required
    "searchContextSize": "medium",     // "low" | "medium" | "high"; provider default when unset
    "allowedDomains": ["example.com"], // string[], no default
    "providerParams": {                // optional, provider-native extras
      "openai":     { "user_location": { "type": "approximate" } },
      "openrouter": { "engine": "exa", "max_results": 10 }
    }
  },
  "fetch": {                           // web_fetch — omit to disable
    "provider": "anthropic",           // string, required
    "model": "claude-opus-4-8",        // string, required
    "maxUses": 5,                      // integer ≥ 1, default 5 — max fetches per request
    "maxContentTokens": 100000,        // integer ≥ 1, default 100000 — approximate content cap
    "allowedDomains": ["example.com"],          // string[], no default
    "blockedDomains": ["private.example.com"],  // string[], no default
    "providerParams": {                // optional, provider passthroughs
      "anthropic":  { "citations": true, "dynamicFiltering": false },  // booleans
      "openrouter": { "engine": "openrouter" }  // "openrouter" | "exa" — never "auto"
    }
  }
}
```

The minimum configuration is one section with `provider` and `model`:

```json
{ "search": { "provider": "openai", "model": "gpt-5.5" } }
```

### Configuration Details

- `provider`/`model` — non-empty strings; must exist in pi's model registry (with a `baseUrl`). Search accepts custom OpenAI-compatible provider IDs and uses the standard Responses request shape for them; `openrouter` and `openai-codex` use specialized adapters. Fetch accepts custom Anthropic-compatible provider IDs and uses the standard Messages request shape for them; `openrouter` uses its specialized adapter. `openai-codex` is not supported for fetch because its backend has no web-fetch capability.
- Common params sit flat in the section and are honored by every provider. Search common params act as defaults for the agent's per-call arguments (`search_context_size`/`allowed_domains` in a tool call win).
- `providerParams` is keyed by provider; only the **active** provider's block is applied, so you can keep several providers configured and switch `provider` freely — the wrong provider's params are never sent. Unknown provider keys are tolerated; unknown fields in known blocks are ignored.
- `searchContextSize` must be one of `low|medium|high`; `maxUses`/`maxContentTokens` must be positive integers; domain lists must be string arrays.
- `fetch.providerParams.openrouter.engine` rejects `auto`/`native` (see below); `anthropic.citations`/`dynamicFiltering` must be booleans.
- Legacy top-level `provider`/`model`/`providerParams`/`webFetch` keys are rejected with a migration message; at least one section must be present.
- Validation runs at session start; a tool that fails validation (or whose model is missing from the registry) is disabled independently with a warning rather than registered broken.

## Provides

- `web_search` tool — params: `query` (required), `max_results`, `search_context_size`, `allowed_domains`.
- `web_fetch` tool — fetches one URL per call, subject to the configured caps and domain filters.

## Special Setup Instructions

Credentials come from pi's model registry for the configured provider — no API keys in this config. Credentials are re-resolved on every call, so mid-session key changes are picked up.

### Search via ChatGPT OAuth (`openai-codex`)

`search.provider: "openai-codex"` serves `web_search` from the ChatGPT/Codex backend (`https://chatgpt.com/backend-api/codex/responses`) using a ChatGPT Plus/Pro OAuth login instead of a metered API key — usage counts against the plan's rate limits. Details:

- The backend is SSE-only and demands codex-client identification; the adapter sends the required headers (`chatgpt-account-id` decoded from the OAuth token, `originator`, `OpenAI-Beta: responses=experimental`) and reassembles the response from the event stream (its `response.completed` event carries an empty `output`). The reference for this transport is pi-ai's `api/openai-codex-responses.js` — if OpenAI changes the contract, pi-ai tracks it.
- `search_context_size` and `allowed_domains` are accepted by the backend.
- The backend emits no `url_citation` annotations (with or without domain filters), so the tool's Sources list is empty; any citations appear inline in the answer text.
- The model must exist upstream, which is a stricter check than pi's registry: registry ids can 404 on the backend (e.g. `gpt-5.6-luna` at the time of writing; `gpt-5.5`, `gpt-5.4`, `gpt-5.6-sol` work).
- `fetch.provider: "openai-codex"` is rejected — the backend has no web-fetch capability. Use `anthropic` or `openrouter` for `web_fetch`, or omit the `fetch` section.

## Limitations and Technical details

The two fetch backends are not perfectly symmetric; differences are documented rather than faked:

- **Engine pinning (OpenRouter)** — `engine` defaults to `openrouter`; `auto`/`native` are rejected because auto resolution is non-deterministic and the native engine ignores `max_content_tokens`. Both pinnable engines (`openrouter`, `exa`) honor the token cap and domain filters, matching Anthropic. OpenRouter also carries a hard 50-fetch/request ceiling.
- **URL restriction (Anthropic only)** — Anthropic only fetches URLs already present in the conversation context; the adapter embeds the requested URL verbatim in its constructed message, so this is transparent — but Anthropic will never follow URLs the model invents. OpenRouter has no such restriction.
- **Raw content (degraded on OpenRouter)** — Anthropic returns the actual page (full text, `title`, `retrieved_at`, typed `error_code`s). OpenRouter delivers the structured result only to the model; the tool result is the model's reproduction of the page, and `title`/`retrievedAt` are usually absent. The adapter opportunistically accepts a structured object if OpenRouter ever surfaces one, but don't rely on it.
- **PDFs** — deliberately unsupported (Anthropic returns base64, OpenRouter pre-extracts text); a PDF fetch on Anthropic maps to `unsupported_content_type`. `FetchResult.content` is always `{ kind: "text" }`.
- **Citations (Anthropic only)** — `citations: true` passes `char_location` citations through; the field is simply absent on OpenRouter. Treat `citations` as optional.
- **Errors** — both providers normalize to `error: { code, message? }`. Anthropic's typed enum (`url_not_accessible`, `max_uses_exceeded`, `url_not_allowed`, `unsupported_content_type`, …) passes through verbatim; OpenRouter's free-text failures are pattern-matched onto the same codes (fallback `fetch_failed`) with the original text preserved in `message`.
- pi exposes no internal API for provider endpoints, so the tools issue HTTP requests themselves via `fetch()` — auth is still resolved through pi's model registry, never rolled by hand.
- The `web-access-smoke-test` skill (repo-local, in `.pi/skills/`) exercises both tools end-to-end after code changes.
