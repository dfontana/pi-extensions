# mcp

A lean [Model Context Protocol](https://modelcontextprotocol.io) client for pi. Reads standard `.mcp.json` (read-only), connects stdio + HTTP servers lazily, caches tool metadata, and exposes every server through a single `mcp` proxy tool. Supports bearer and OAuth auth (PKCE, dynamic client registration, token refresh).

## Configuration

`~/.pi/agent/mcp.json` (global) and `./.mcp.json` (project), merged by server name with project winning. The extension **never writes** these files.

```jsonc
{
  "mcpServers": {
    "filesystem": {                       // stdio server
      "command": "npx",                   // string, required for stdio
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],  // string[]
      "env": { "TOKEN": "${MY_TOKEN}" },  // object; values support ${VAR} and $env:VAR
      "cwd": "~/projects"                 // string; supports ~ and env expansion
    },
    "linear": {                           // http server
      "url": "https://mcp.linear.app/mcp",  // string, required for http
      "headers": { "X-Org": "$env:ORG" },   // object; env-expanded, sent on every request
      "auth": "oauth",                    // "none" | "bearer" | "oauth"; inferred when omitted
      "bearerToken": "…",                 // string; static token
      "bearerTokenEnv": "LINEAR_TOKEN",   // string; env var to read the token from
      "oauth": {                          // object, all fields optional
        "redirectUri": "…",
        "grantType": "authorization_code",  // or "client_credentials"
        "scope": "…",
        "clientId": "…",
        "clientSecret": "…"
      }
    }
  }
}
```

The minimum configuration is one server with either `command` (stdio) or `url` (HTTP):

```json
{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" } } }
```

### Configuration Details

- `command`/`args`/`env`/`cwd` — launch a local stdio server. A server with neither `command` nor `url` is invalid.
- `url` — StreamableHTTP endpoint (SSE fallback handled by the SDK).
- Env expansion recognizes `${VAR}` and `$env:VAR` (unknown vars become `""`); bare `$VAR` is left alone so literal `$` in tokens survives.
- `auth` — explicit value wins; otherwise inferred: `bearer` if a token is set, else `oauth` for any `url`, else `none`.
- `bearerTokenEnv` overrides `bearerToken` when both are set.
- `oauth.grantType: "client_credentials"` with `clientId`/`clientSecret` enables browserless machine auth.

## Provides

- `mcp` tool — one proxy tool, several modes (pass exactly one):

  | Call | Does |
  |---|---|
  | `mcp({})` | Status of every server (state + tool counts) |
  | `mcp({ server })` | List a server's tools |
  | `mcp({ search })` | Substring search across enabled servers; space-separated terms are OR'd; `regex: true` for regex |
  | `mcp({ describe })` | One tool's server, description, and input schema |
  | `mcp({ tool, args })` | Call a tool; `args` is a JSON object string; `tool` may be bare or `server_tool` |
  | `mcp({ connect })` | Force a connect + metadata refresh |
  | `mcp({ action, server })` | OAuth helpers: `auth-start` returns a URL, `auth-complete` finishes with `args: '{"redirectUrl":"…"}'` |

  Tools are advertised as `server_tool`; ambiguous bare names report the candidates.

- `/mcp` command — server panel: `↑↓`/`jk` move · `space`/`enter` toggle · `r` reconnect · `a` authenticate (interactive OAuth: localhost callback + browser) · `esc`/`q` close.

## Special Setup Instructions

Servers default to **off** every session — curate the active set from the `/mcp` panel before the agent can reach them.

## Limitations and Technical details

- State on disk under `~/.pi/agent/mcp/`: `auth.json` (OAuth credentials, keyed by server URL — never written to `.mcp.json` or the session) and `cache.json` (tool metadata keyed by a server-identity hash, 7-day TTL). The cache lets status/list/search/describe work without a live connection; actual tool calls trigger a lazy connect. Cache is an optimization, never the source of truth.
- Intentionally out of scope: direct-tool promotion, MCP UI/Glimpse, host-config imports (Cursor/Claude/VS Code/…), setup wizards, sampling, elicitation, and an `npx` binary resolver. This is a single-proxy MCP client, nothing more.
