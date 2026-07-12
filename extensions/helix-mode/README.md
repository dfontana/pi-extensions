# helix-mode

Modal editing for pi's input box, inspired by [Helix](https://helix-editor.com/): Normal / Insert / Select modes with word-level navigation, jump-to-word labels, selection-based search, and indent/unindent. Enabled by default.

## Configuration

None.

## Provides

- Replaces pi's editor component with the Helix-style editor.
- `/helix` command — toggles helix mode on/off (no arguments; the default editor is restored while off).

### Modes

| Mode | Indicator | How to enter |
|---|---|---|
| Insert | `INSERT` (dim) | Start here; or `i`/`a`/`o`/`O` from Normal |
| Normal | `NORMAL` (cyan) | `Escape` from Insert |
| Select | `SELECT (N)` (yellow) | `v` from Normal; N = selected char count |

### Normal mode — movement

| Key | Action |
|---|---|
| `h`/`←`, `l`/`→` | Character left / right |
| `j`/`↓`, `k`/`↑` | Line down / up |
| `w`, `b`, `e` | Next word start / previous word start / next word end |
| `0`/`Home`, `$`/`End` | Line start / end |
| `gg`, `ge` | Buffer start / end |
| `gw` | Jump-to-word: labels appear on word starts — type a label to jump |

### Normal mode — mode entry and changes

| Key | Action |
|---|---|
| `i`, `a` | Insert before / after cursor |
| `o`, `O` | Open line below / above, enter Insert |
| `v` | Enter Select mode (anchor = cursor) |
| `Escape` | In Normal: abort agent (pi default). In Select: back to Normal. |
| `d` | Delete selection (or char under cursor) |
| `c` | Change: delete selection, enter Insert |
| `y` | Yank non-empty selection to the system clipboard |
| `r` + char | Replace character under cursor |
| `x` | Select current line (extends line-wise if repeated) |
| `>` / `<` | Indent / unindent selected lines by 2 spaces |

### Search & selection

| Key | Action |
|---|---|
| `*` | Use word under cursor (or selection) as search pattern (word-boundary wrapped) |
| `n` / `N` | Next / previous match (wraps) |
| `s` | Regex prompt — select first match within the current selection |
| `/` | Passes through to pi's default search, entering Insert |

Matches are highlighted as Select-mode selections. In Select mode all movement keys extend the selection; `d`, `c`, `y`, `>`, `<`, and `s` operate on the full selection.

## Limitations and Technical details

- No true multi-cursor (use `*` + `n`/`N` to walk matches one at a time).
- Selection is not visually highlighted in the text — only the char count in the mode indicator.
- No count prefixes (`3w`, `5j`, etc.).
- Black-box tests live in `__tests__/` and exercise public editor behavior only (simulated input, buffer/cursor state, normalized `render(width)` output).
