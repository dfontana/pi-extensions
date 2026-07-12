# prompt-stash

Stash and restore the prompt editor's contents with one keystroke — handy when you need to interrupt a half-written prompt to send something else first.

## Configuration

None.

## Provides

- `Alt+Shift+S` shortcut — if nothing is stashed, saves the current editor text and clears the editor (a `● stashed` footer indicator appears); if something is stashed, restores it. Stashing an empty editor is a no-op with an info notice.

## Limitations and Technical details

- One stash slot, held in memory only — it does not survive a restart and is cleared on session start.
