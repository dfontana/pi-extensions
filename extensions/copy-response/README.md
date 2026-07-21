# copy-response

Adds `/cp` — copy the last assistant response, or an individual code block from
it, to the system clipboard with whitespace normalized so the content keeps its
formatting when pasted elsewhere.

## Usage

Run `/cp` after a response. If the response contains no fenced code blocks, the
whole response is copied immediately. Otherwise a picker offers:

- **Entire response**
- **Block N · `<lang>` · `<n>` lines** — one entry per fenced code block
- **All code blocks** — every block joined by a blank line (only when there is
  more than one)

Copying uses pi's own clipboard path (`wl-copy` / `xclip` / `xsel`, the macOS
native clipboard, or an OSC 52 fallback over SSH).

## Whitespace normalization

The point of the extension: pasted blocks arrive clean, without the leading
indentation or trailing cruft that otherwise botches ASCII diagrams and code
snippets.

**Per code block** (the important path):

1. Trailing spaces/tabs are stripped from every line.
2. Leading and trailing blank lines are dropped; interior blank lines are kept.
3. The block is dedented by the longest leading-whitespace prefix common to all
   non-blank lines, compared character-by-character (Python `textwrap.dedent`
   semantics). This is tab/space-safe — only genuinely shared whitespace is
   removed, so relative indentation is never corrupted, and if any line sits at
   column zero nothing is dedented.

**Entire response**: steps 1 and 2 only. It is deliberately **not** dedented,
because a full message mixes prose with intentionally indented code, and
dedenting it as one unit would shift that code.

All EOLs are normalized to `\n` and no trailing newline is added.

## Limitations

- Operates on the most recent assistant message only.
- Only fenced code blocks (` ``` ` / `~~~`) are detected as blocks; 4-space
  indented code is treated as prose.
- The picker is a flat label list (no live preview).
