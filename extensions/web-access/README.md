# web-access

Gives the pi agent two tools backed by a configured model provider:

- **`web_search`** — search the web via an OpenAI-style Responses API
  (providers: `openai`, `openrouter`).
- **`web_fetch`** — fetch the text content of a specific URL via a server-side
  fetch tool (providers: `anthropic` via the Messages API, `openrouter` via
  chat/completions).

Providers/models come from `web-access.json` (global `~/.pi/agent/`, with a
project-level `./.pi/web-access.json` override merged on top). **Each tool is
configured by its own section with its own provider and model**, so search and
fetch can be served by different providers — no single provider has to support
both tools. Omit a section to disable that tool; tools that fail validation at
session start are disabled independently with a warning rather than registered
broken.

## Configuration

Both sections share the same shape:

1. **`provider` and `model`** — required; the only fields you must set.
2. **Common params** — flat in the section; honored by every provider.
3. **`providerParams`** — keyed by provider, for the params the providers
   don't share. Only the active provider's block is ever applied, so you can
   keep several providers' params configured and switch `provider` freely
   without reshuffling them — and the wrong provider's params are never sent
   to a provider that might reject unknown tool fields.

Known providers — search: `openai`, `openrouter` (any other provider id gets
the OpenAI request shape, the spec third parties implement); fetch:
`anthropic`, `openrouter` (any other provider id gets the Anthropic shape).

```jsonc
{
  // web_search
  "search": {
    "provider": "openai",            // required
    "model": "gpt-5.5",              // required

    // Common params (both providers support these):
    "searchContextSize": "medium",   // "low" | "medium" | "high"; provider default when unset
    "allowedDomains": ["example.com"],

    "providerParams": {              // optional — provider-native extras
      "openai": { "user_location": { "type": "approximate" } },
      "openrouter": { "engine": "exa", "max_results": 10 }
    }
  },

  // web_fetch
  "fetch": {
    "provider": "anthropic",         // required
    "model": "claude-opus-4-8",      // required

    // Common params (defaults shown):
    "maxUses": 5,                    // max fetches per request
    "maxContentTokens": 100000,      // approximate content cap
    "allowedDomains": ["example.com"],          // no default
    "blockedDomains": ["private.example.com"],  // no default

    "providerParams": {              // optional — provider passthroughs
      "anthropic": {
        "citations": true,           // char_location citations
        "dynamicFiltering": false    // opt into web_fetch_20260209
      },
      "openrouter": {
        "engine": "openrouter"       // "openrouter" | "exa" (never "auto")
      }
    }
  }
}
```

The search common params act as defaults for the agent's per-call arguments
(an explicit `search_context_size`/`allowed_domains` in a tool call wins).

## web_fetch behavioral contract

The goal is a consistent experience across backends, but the two APIs are not
perfectly symmetric. The differences below are inherent to the providers — we
document them rather than fake parity.

### Engine pinning (OpenRouter)

The OpenRouter `engine` defaults to `openrouter` and the config loader rejects
`auto`/`native`. Rationale:

- `auto`/`native` resolution is non-deterministic (depends on the upstream
  model provider), so the same request can behave differently across calls.
- The `native` engine ignores `max_content_tokens` entirely, silently breaking
  the token-truncation contract.
- Both pinnable engines (`openrouter`, `exa`) honor `max_content_tokens` and
  the domain filters, matching Anthropic's behavior. (`openrouter`/`native`
  also carry a hard 50-fetch/request ceiling.)

### URL restriction (Anthropic only)

For security, Anthropic's web fetch only fetches URLs that already appear in
the conversation context sent to it. The adapter therefore embeds the
requested URL verbatim in the user message it constructs, so this is
transparent in practice — but Anthropic will never follow URLs the model
invents. OpenRouter has no such restriction.

### Raw content access (degraded on OpenRouter)

- **Anthropic** returns the raw fetched page to the API caller as a
  `web_fetch_tool_result` block: full text, `title`, `retrieved_at`, plus
  typed `error_code`s on failure. The tool result you see is the actual page
  content.
- **OpenRouter** delivers the structured fetch result
  (`{url, title, content, status, retrieved_at, error}`) only to the *model*;
  the API caller receives just the model's synthesized text in
  `choices[0].message.content`. The tool result is therefore the model's
  reproduction of the page, not the page itself, and `title`/`retrievedAt`
  are usually absent. The adapter still accepts the flat structured object
  opportunistically (if OpenRouter ever surfaces it, fidelity comes back for
  free), but do not rely on it.

### PDFs (unsupported)

The providers are asymmetric here — Anthropic returns PDFs as base64
(`application/pdf`), OpenRouter engines pre-extract text — so PDF support is
deliberately **disabled**: a PDF fetch on Anthropic maps to an
`unsupported_content_type` error. `FetchResult.content` is always
`{ kind: "text" }`.

### Citations (Anthropic only)

`citations: true` makes Anthropic attach `char_location` citations, which the
tool passes through in the result. OpenRouter has no equivalent for web fetch;
the field is simply absent there. Code consuming results must treat
`citations` as optional.

### Errors

Both error models normalize to `error: { code, message? }`:

- Anthropic's typed `error_code` enum (`url_not_accessible`,
  `max_uses_exceeded`, `url_not_allowed`, `unsupported_content_type`, …)
  passes through verbatim.
- OpenRouter's `status: "failed"` + free-text `error` is pattern-matched onto
  the same codes, falling back to `fetch_failed`; the original free text is
  preserved in `message`.
