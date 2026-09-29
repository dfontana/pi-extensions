# gateway

Registers existing pi model providers against a configurable internal gateway. The extension does not define model catalogs: pi's models for each provider remain authoritative, while this extension supplies only the provider URL and auth settings.

## Configuration

Create `~/.pi/agent/gateway.json` (the standard `PI_CODING_AGENT_DIR` override is honored):

```json
{
  "gateway": "https://gateway.example",
  "key-command": "credential-helper token",
  "headers": {
    "x-organization": "example"
  },
  "providers": [
    {
      "provider": "anthropic",
      "baseUrl": "$GATEWAY",
      "authHeader": "true",
      "headers": {
        "provider": "anthropic"
      }
    },
    {
      "provider": "openai",
      "baseUrl": "$GATEWAY/v1",
      "authHeader": "false",
      "headers": {
        "provider": "openai"
      }
    }
  ]
}
```

- `gateway` is substituted for every `$GATEWAY` in each provider's `baseUrl`.
- `key-command` is given to pi as its native `!command` API-key value. It runs when pi resolves provider auth; print only the key on stdout. The extension never executes or stores the returned key itself.
- Top-level `headers` are common to every provider. Provider-level headers are merged on top, replacing a common value when the same key appears in both objects.
- `authHeader` accepts JSON booleans or the quoted strings `"true"`/`"false"` shown above; it becomes pi's boolean `authHeader` setting.
- `providers` must identify providers whose models are already known to pi. No `models` property is registered or written to `models.json`.

The extension does nothing when the file is absent. Invalid configuration is reported as a session warning. Changes are picked up when the extension is reloaded.
