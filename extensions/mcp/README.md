# mcp

A lean [Model Context Protocol](https://modelcontextprotocol.io) client for pi.
Reads standard `.mcp.json`, connects stdio + HTTP servers lazily, caches tool
metadata, and exposes every server through a single `mcp` proxy tool.

## Quick start

1. Create `./.mcp.json` (project) or `~/.config/mcp/mcp.json` (global):

   ```json
   {
     "mcpServers": {
       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
       "linear": { "url": "https://mcp.linear.app/mcp" }
     }
   }
   ```

2. Run `/mcp`, press `space` to enable the servers you want, `esc` to close.
3. The agent now reaches them via the `mcp` tool. Authenticate OAuth servers with `a` in the panel.

Servers default to **off** every session — you curate which are active from the
`/mcp` panel.

## Config (`.mcp.json`, read-only)

Files are merged in precedence order (project overrides global), keyed by server name:

1. `~/.config/mcp/mcp.json`
2. `./.mcp.json`

The extension **never writes** to these files. Standard `command`/`args`/`env`
is honored; the following non-standard fields are recognized for HTTP/OAuth and
are clearly marked as this extension's own:

| Field | Type | Applies to | Notes |
|---|---|---|---|
| `command`, `args` | string, string[] | stdio | Launch a local server. |
| `env` | object | stdio | Values support `${VAR}` and `$env:VAR`. |
| `cwd` | string | stdio | Supports `~` and env expansion. |
| `url` | string | http | StreamableHTTP endpoint (SSE fallback handled by the SDK). |
| `headers` | object | http | Sent on every request; values are env-expanded. |
| `auth` | `"none"`/`"bearer"`/`"oauth"` | http | Inferred when omitted: `bearer` if a token is set, else `oauth` for any `url`. |
| `bearerToken` / `bearerTokenEnv` | string | http | Static token, or the env var to read it from. |
| `oauth` | object | http | `{ redirectUri?, grantType?, scope?, clientId?, clientSecret? }`. `grantType: "client_credentials"` for machine auth. |

## The `mcp` tool

One tool, several modes (pass exactly one):

| Call | Does |
|---|---|
| `mcp({})` | Status of every server (state + tool counts). |
| `mcp({ server })` | List a server's tools. |
| `mcp({ search })` | Substring search across enabled servers; space-separated terms are OR'd. Add `regex: true` for a regex. |
| `mcp({ describe })` | One tool's server, description, and input schema. |
| `mcp({ tool, args })` | Call a tool. `args` is a JSON object string. `tool` may be bare or `server_tool`. |
| `mcp({ connect })` | Force a connect + metadata refresh. |
| `mcp({ action })` | OAuth helpers — see below. |

Tools are advertised as `server_tool`. Either the qualified or bare name
resolves; ambiguous bare names report the candidates.

## Command

`/mcp` opens the server panel — everything is managed from here.

Panel keys: `↑↓`/`jk` move · `space` toggle on/off · `r` reconnect · `a` authenticate · `esc` close.

## Authentication

- **Bearer** — set `auth: "bearer"` with `bearerToken`/`bearerTokenEnv`.
- **OAuth (interactive)** — press `a` on a server in the `/mcp` panel to run the
  authorization-code + PKCE flow with dynamic client registration: a localhost
  callback server is started, your browser opens, and tokens are saved and
  refreshed automatically.
- **OAuth (headless)** — `mcp({ action: "auth-start", server })` returns a URL to
  open; after approving, finish with
  `mcp({ action: "auth-complete", server, args: '{"redirectUrl":"<full redirect URL>"}' })`.
- **Machine auth** — set `oauth.grantType: "client_credentials"` with
  `clientId`/`clientSecret`; no browser involved.

Credentials live in `~/.pi/agent/mcp/auth.json` (keyed by server URL), never in
`.mcp.json` or the session.

## State on disk

```
~/.pi/agent/mcp/
  auth.json       ← OAuth credentials, per server URL
  cache.json      ← tool metadata, keyed by server-identity hash (7-day TTL)
```

Metadata is cached so status/list/search/describe work without a live
connection; a missing or stale cache, or an actual tool call, triggers a lazy
connect. Cache is an optimization, never the source of truth.

## Not included

Direct-tool promotion, MCP UI/Glimpse, host-config imports (Cursor/Claude/VS
Code/…), setup wizards, sampling, elicitation, and the `npx` binary resolver are
intentionally out of scope. This is a single-proxy MCP client, nothing more.
