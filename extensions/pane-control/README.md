# pane-control

Gives agents tools to open, drive, inspect, and close terminal panes, so they can test interactive or full-screen TUI programs without relying on shell pipes or a human at the keyboard.

## Configuration

No configuration is required. At session start in an interactive TUI session, the extension probes the active terminal environment and registers tools only when a supported backend responds. Headless sessions skip pane initialization:

1. **Kitty** — preferred when Kitty remote control is reachable. This works through `KITTY_LISTEN_ON` when set, or through Pi's controlling TTY (including an SSH/zmx session with Kitty remote-control authentication).
2. **Zellij** — used when `ZELLIJ_SESSION_NAME` identifies a reachable Zellij session.
3. **Neither** — no tools are registered and Pi shows a warning explaining which probe failed.

The probes run asynchronously and are cached for the Pi process. If the terminal multiplexer becomes available only after Pi starts, reload Pi to probe again.

## Provides

| Tool | Description |
|---|---|
| `pane_open` | Split a pane to the right or below in the invoking pane's current working directory, optionally setting its title or `sh -c` command. Returns a `pane_id`. |
| `pane_send` | Type literal text, press Enter, or send named key presses such as `Ctrl+C`, `Shift+Up`, and `F5`. |
| `pane_read` | Dump the rendered pane contents, with optional scrollback and ANSI escape sequences. |
| `pane_close` | Close a pane and stop the process running in it. |
| `pane_list` | List the current session's panes, including IDs, titles, and commands when available. |

Pane operations are sequential: open a pane, wait for its prompt when necessary, send input, then read its screen. Fresh shells may need a moment to initialize; if input is garbled or absent, read the pane and resend after the prompt is visible. Close any panes you open when finished.

## Limitations and technical details

- `pane_open` starts a fresh shell in the invoking pane's current working directory. To use a different directory, `cd` after opening. It does not inherit Pi's environment variables; source any required environment files inside the pane.
- Pane IDs are backend-specific. Use the ID returned by `pane_open` or discovered with `pane_list`.
- Only control panes you created unless the user explicitly asks you to use an existing pane.
- A plain pane dump does not show focus or selection colors. Use `ansi: true` to inspect styling escapes, or verify focus through behavior.
- Kitty remote control requires either a usable listen socket or a controlling TTY that can carry its authentication protocol. If this is unavailable, the extension falls back to Zellij when possible.
