# no-git-for-jj

Blocks `git` commands in the bash tool when the working directory is a Jujutsu repo, and suggests the equivalent `jj` command instead. Keeps the agent from mixing git and jj state.

## Configuration

None.

## Provides

- A `tool_call` guard on the bash tool: any command containing a known `git <subcommand>` is blocked with a message mapping it to the jj equivalent (e.g. `git status` → `jj status`, `git commit` → `jj commit -m`, `git push` → `jj git push`).

## Limitations and Technical details

- Repo detection runs `jj root --quiet` in the tool call's cwd (5s timeout); outside a jj repo the extension does nothing.
- `jj git …` subcommands (`jj git push`, `jj git fetch`) are always allowed.
- Only a fixed list of git subcommands is matched (add, branch, checkout, commit, diff, fetch, init, log, merge, pull, push, rebase, reset, restore, revert, status, stash, switch, tag) — other git invocations pass through.
- Matching is substring-based with a word-boundary check on the left of `git`, so it also catches git inside compound commands, but can't evaluate shell semantics (e.g. it will block a quoted string containing `git status`).
