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

Without an explicit `--mcp` value or child snapshot, servers default to **off** in a new session — curate the active set from the `/mcp` panel before the agent can reach them.

## CLI selection and child handoff

The external extension registers `--mcp <names>` to select an explicit comma-separated server set at startup (for example, `pi --mcp filesystem,linear`). Names are matched exactly after trimming whitespace; duplicate and empty comma-separated entries are ignored. Unknown names produce a warning and are skipped. Pass an explicit empty string (`pi --mcp ""` or `pi --mcp=`) to select no servers.

An explicit `--mcp` value, including empty, overrides both an inherited child snapshot and saved session state at each `session_start`. Pi reuses the process flag for reloads and replacement sessions (new, resume, and fork), so the original selection is reapplied then and can undo later panel changes. When the flag is absent, existing precedence is unchanged: a child launch snapshot wins over saved session state; otherwise the active branch's saved set is restored, and a new session with no saved set starts with everything off. The snapshot environment value is consumed even when `--mcp` overrides it.

For a launcher such as Demi that offers `names` / `inherit` / `none` modes, use these argv/environment rules:

- **names** — pass `--mcp <comma-separated names>`; this explicit set wins over any child snapshot.
- **inherit** — omit `--mcp` and preserve the launch environment. Subagent launches already provide the parent's enabled-set snapshot in `PI_EXTENSIONS_MCP_ENABLED_SNAPSHOT`.
- **none** — pass `--mcp ""`; the explicit empty set disables all configured servers even if a snapshot is present.

This flag controls this external extension only; it does not use or configure Pi's built-in MCP support.

## Session persistence

The enabled set is recorded in the session as an `mcp-enabled` custom entry (server names and identity hashes only) whenever it changes: on closing the `/mcp` panel and after a successful Shift+A re-authentication. Unchanged sets are not re-recorded.

On `/reload`, resume, or fork, the newest record on the active branch is restored when the process has no explicit `--mcp`; an original CLI selection is reapplied on those `session_start` events instead and may override later panel changes. Navigating with `/tree` adopts the target branch's record even when the process started with `--mcp` (all off when the branch has none). Thus the flag is a startup selection, not a permanent denylist. Without a CLI override, `/new` starts with everything off. Servers are matched by name when restoring saved branch state, so a server whose configuration changed stays enabled; a server no longer configured stays off and produces a warning. Restoring never connects: servers reconnect lazily on first use.

## Child agent inheritance

Each child process receives a point-in-time snapshot of the parent's enabled server set at launch. The handoff contains only server names and configuration identity hashes; it contains no credentials or server configuration. During child startup, MCP removes the handoff value from the process environment and, unless an explicit `--mcp` flag overrides it, enables only entries whose identity matches the child's independently loaded configuration.

Snapshots are launch-scoped and isolated for parallel children. Child connections and subsequent enable/disable changes do not affect the parent or siblings. When `--mcp` is absent, a launch snapshot takes precedence over any enabled set recorded in the child's session. New Pi sessions without an explicit flag or child snapshot start with all servers off as usual.

Capability scoping remains authoritative. If a child does not load MCP, it cannot consume or use the snapshot. If its tool list excludes `mcp`, MCP may initialize the inherited enabled set, but the child still has no tool with which to reach those servers.

## Limitations and Technical details

- On **macOS**, OAuth credentials persist only in Keychain via Security.framework ([`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node), service `pi-extensions`). Each account is `mcp.oauth.` plus a SHA-256 hash of the agent's MCP state directory and exact server URL, isolating agent directories and server identities. One JSON record stores registration, tokens, discovery metadata, and in-progress OAuth state. Keychain failures raise errors; macOS never falls back to plaintext.
- On **other operating systems**, OAuth credentials use the plaintext file adapter at `~/.pi/agent/mcp/auth.json`, keyed by server URL. Credentials are never written to `.mcp.json` or session files. Storage errors propagate; Shift+A clearing failures appear as error notifications and do not start authentication.
- On macOS, existing `~/.pi/agent/mcp/auth.json` files are **not read, migrated, or deleted automatically**. Re-authenticate to create Keychain credentials; manage any legacy plaintext file yourself. Other platforms continue to read and update that file.
- Tool metadata remains on disk under `~/.pi/agent/mcp/cache.json`, keyed by a server-identity hash (7-day TTL). The cache lets status/list/search/describe work without a live connection; actual tool calls trigger a lazy connect. Cache is an optimization, never the source of truth.
- Enable/disable controls whether the current session exposes a server to the agent and is recorded in the session; it does not connect or disconnect it. Restart (`R`, Shift+R) enables the server, clears any auth latch, replaces any live transport, and refreshes its tool metadata, while retaining OAuth credentials. Re-authenticate (`A`, Shift+A) also clears the auth latch and all locally saved OAuth state first, so the next connection obtains fresh credentials.
- OAuth auth is implicit: the first connect that needs auth opens a browser, awaits the callback (up to 120 seconds), exchanges the code, and reconnects exactly once. Multiple concurrent calls for the same URL coalesce to a single browser flow. A successful `client_credentials` grant is non-interactive. On failure the error is latched for that session so no further browser flows are attempted automatically.
- Intentionally out of scope: direct-tool promotion, MCP UI/Glimpse, host-config imports (Cursor/Claude/VS Code/…), setup wizards, sampling, elicitation, and an `npx` binary resolver. This is a single-proxy MCP client, nothing more.
