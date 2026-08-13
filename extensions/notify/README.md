# notify

Desktop notification, terminal bell, and Zellij tab marker when Pi finishes a turn and is waiting for input — so you notice from another window, tab, or muted desktop.

## Configuration

One optional environment variable:

```sh
PI_NOTIFY_SOUND_CMD="afplay /path/to/ding.wav"   # string, no default
```

The minimum configuration is: none.

### Configuration Details

- `PI_NOTIFY_SOUND_CMD` — a shell command spawned (detached, output ignored) with every notification. Errors are silently swallowed. Unset means no sound hook; the terminal bell still rings.

## Provides

- On `agent_settled` in TUI mode: terminal bell (`\x07`) + a desktop notification ("Pi — Ready for input") via OSC escape sequences, + the sound hook.
- In Zellij/TUI: a `• ` prefix added to the tab name on `agent_settled`, cleared on `agent_start` and on quit.
- Headless modes do not write terminal notifications or update Zellij tabs.
- `/ack` command — manually clears the Zellij tab dot (no-op outside Zellij).

## Special Setup Instructions

- Notification protocol is chosen automatically: OSC 99 when `KITTY_WINDOW_ID` is set (Kitty), otherwise OSC 777 (Ghostty, WezTerm, rxvt-unicode, Zellij 0.39+ passthrough). Inside tmux, sequences are wrapped in the tmux passthrough DCS — enable `allow-passthrough` in tmux for them to reach the terminal.
- The tab dot requires the `zellij` CLI (`zellij action list-panes/rename-tab`) and the `ZELLIJ_PANE_ID` env var.

## Limitations and Technical details

- The tab id is resolved once when first needed; the live tab *name* is re-fetched before every rename, so tabs you rename mid-session keep their new name (only the dot is added/removed).
- If the terminal supports neither OSC protocol the notification is silently ignored — the bell is the fallback signal.
