---
name: jujutsu
description: >
  Use when the repository contains a .jj/ directory. Provides Jujutsu (jj)
  version control workflow rules and command reference. Load this skill
  immediately when a .jj/ directory is detected at the repository root.
---

# Jujutsu Version Control

This repository uses **jj** (Jujutsu). Never use raw `git` commands for
commits, history, or diffs — use `jj` exclusively.

## Pre-Work Checklist (Primary Agent Only)

Before writing any code, complete these steps in order:

1. **Check `@` is empty**: run `jj diff -r @`
   - If output is non-empty, the working copy has uncommitted changes.
     Stop and surface this to the user before proceeding — do not write
     code on top of an existing revision without explicit instruction.
2. **Declare intent**: run `jj describe -m "<what this revision will contain>"`
   before writing any code. The description is a stated plan, not an
   afterthought.

## Subagent Restrictions

Subagents are **inspect-only by default**. Permitted commands:

- `jj log`, `jj status`, `jj diff`

A narrow exception allows a subagent to edit working-copy files only when the
primary agent explicitly designates it as the implementation/fixer agent for a
workflow that requires code changes. Review, exploration, and research agents
remain inspect-only. The designation must be stated in the subagent's prompt;
it is never inferred from a general request.

No subagent, including a designated implementer, may run `jj commit`,
`jj describe`, `jj squash`, `jj new`, or any other mutating `jj` command. The
primary agent retains responsibility for revision state. If a subagent detects
it is on a non-empty `@` and cannot safely perform its assigned role, it must
defer to the parent agent.

## Commit Discipline

- Each revision must contain one logical chunk of work.
- `jj commit -m "..."` finalizes the current revision and opens a fresh empty `@`.
- Related work across multiple revisions should be squashed before presenting
  to the user: `jj squash -r <rev> --into <target>`

## Command Reference

| Task | Command |
|------|---------|
| Check working copy status | `jj status` |
| Check if `@` is empty | `jj diff -r @` |
| View commit history | `jj log` |
| View a specific revision's diff | `jj diff -r <rev>` |
| Set description before coding | `jj describe -m "<intent>"` |
| Finalize revision, start fresh | `jj commit -m "<message>"` |
| Start a new empty revision explicitly | `jj new` |
| Squash revision into another | `jj squash -r <rev> --into <target>` |

## Key Differences from Git

- No staging area — all edits are automatically part of `@`
- `@` is always the working-copy revision
- `jj commit` = finalize `@` and create a new empty one (like `git commit -a` + fresh branch)
- `jj describe` = change the message of `@` without creating a new revision
- `jj new` = explicitly start a new empty revision without finalizing the current one
