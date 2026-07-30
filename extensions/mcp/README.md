# mcp

A lean [Model Context Protocol](https://modelcontextprotocol.io) client for pi. Reads standard `.mcp.json` (read-only), connects stdio + HTTP servers lazily, caches tool metadata, and exposes every server through a single `mcp` proxy tool. Supports bearer and OAuth auth (PKCE, dynamic client registration, token refresh). Connection and authentication are fully implicit — agents never connect or authenticate manually.

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
- A local stdio server inherits Pi's environment, except values beginning with `()` (exported shell functions, which are excluded as a security precaution). Its configured `env` values overlay inherited values.
- `auth` — explicit value wins; otherwise inferred: `bearer` if a token is set, else `oauth` for any `url`, else `none`.
- `bearerTokenEnv` overrides `bearerToken` when both are set.
- `oauth.grantType: "client_credentials"` with `clientId`/`clientSecret` enables browserless machine auth.

## Provides

- `mcp` tool — one proxy tool, one required `action` field. Pass exactly one action:

  | Action | Required fields | Optional fields | Does |
  |---|---|---|---|
  | `"status"` | — | — | Status of every configured server (state + tool counts) |
  | `"list-tools"` | `server` | — | List all tools exposed by the named server |
  | `"search-tools"` | `search` | `regex` | Substring search across all enabled servers; space-separated terms are OR'd; `regex: true` for regex |
  | `"describe-tool"` | `tool` | — | One tool's server, description, and input schema |
  | `"invoke-tool"` | `tool` | `args` | Call a tool; `args` is a JSON object string; `tool` may be bare or `server_tool` |

  Canonical call shapes:

  ```ts
  mcp({ action: "status" })
  mcp({ action: "list-tools", server: "datadog" })
  mcp({ action: "search-tools", search: "monitor" })
  mcp({ action: "search-tools", search: "^mon", regex: true })
  mcp({ action: "describe-tool", tool: "datadog_get_monitor" })
  mcp({ action: "invoke-tool", tool: "datadog_get_monitor", args: '{"id": 123}' })
  ```

  Tools are advertised as `server_tool`; ambiguous bare names report the candidates.

  Connection and OAuth authentication are fully implicit. The first call that needs a live connection establishes it automatically. If OAuth is required, the extension opens a browser and awaits the redirect (up to 120 seconds). The agent never needs to connect or authenticate manually. If authentication fails, the agent should tell the user and ask them to recover via the `/mcp` panel — **do not retry authentication automatically**.

- `/mcp` command — searchable server panel: type to filter server names case-insensitively · `↑↓` move · `backspace` erase filter text · `space`/`enter` enable/disable the selected server · `R` (Shift+R) restart/refresh (clears any auth latch, then re-connects) · `A` (Shift+A) force re-authentication (clears saved OAuth state and the auth latch, then runs a fresh interactive browser flow) · `esc` close.

## Special Setup Instructions

Servers default to **off** every session — curate the active set from the `/mcp` panel before the agent can reach them.

## Child agent (pi-subagents) inheritance

When a child agent is spawned via pi-subagents, the MCP extension automatically passes a validated point-in-time snapshot of the parent's enabled server set to the child through an MCP-owned process-local broker. The child inherits exactly what the parent had enabled at the moment of spawn, subject to identity verification against the child's own loaded config. Child connections and any subsequent enable/disable changes are fully isolated from the parent and from other children.

The inheritance mechanism works only for child agents spawned by pi-subagents (the documented `subagents:started` / session-name contract). Independent sessions (no agent-id suffix in the session name) start with all servers off, as usual.

Capability scoping and the MCP extension are independent:

- **MCP extension not loaded** (e.g. not present in the child's extension set): the extension never initializes, `session_start` is never fired, and the broker entry is not consumed. Completion/failure or stale-age cleanup handles any unconsumed entries.
- **`mcp` tool excluded or narrowed out** (`excludeTools: ["mcp"]` or a restrictive `tools:` list): pi-subagents still binds loaded extensions and fires `session_start`, so the MCP extension *does* initialize and consume the one-shot broker snapshot. The inherited servers are enabled in the manager, but the `mcp` tool is absent from the agent's tool list, so no inherited server can actually be reached. This does not bypass capability scoping — it just means the snapshot is silently consumed and the tool remains unavailable.

## Limitations and Technical details

- State on disk under `~/.pi/agent/mcp/`: `auth.json` (OAuth credentials, keyed by server URL — never written to `.mcp.json` or the session) and `cache.json` (tool metadata keyed by a server-identity hash, 7-day TTL). The cache lets status/list/search/describe work without a live connection; actual tool calls trigger a lazy connect. Cache is an optimization, never the source of truth.
- Enable/disable controls whether the current session exposes a server to the agent; it does not connect or disconnect it. Restart (`R`, Shift+R) enables the server, clears any auth latch, replaces any live transport, and refreshes its tool metadata, while retaining OAuth credentials. Re-authenticate (`A`, Shift+A) also clears the auth latch and all locally saved OAuth state first, so the next connection obtains fresh credentials.
- OAuth auth is implicit: the first connect that needs auth opens a browser, awaits the callback (up to 120 seconds), exchanges the code, and reconnects exactly once. Multiple concurrent calls for the same URL coalesce to a single browser flow. A successful `client_credentials` grant is non-interactive. On failure the error is latched for that session so no further browser flows are attempted automatically.
- Intentionally out of scope: direct-tool promotion, MCP UI/Glimpse, host-config imports (Cursor/Claude/VS Code/…), setup wizards, sampling, elicitation, and an `npx` binary resolver. This is a single-proxy MCP client, nothing more.
