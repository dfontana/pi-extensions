# todo

A minimal task list for the agent, stored in the pi session and shown in a widget above the editor.

## Configuration

None.

## Provides

- **`todo` tool** — one call creates and updates tasks; the result is always the full current list.
  ```ts
  todo({
    create: [{ subject: "Write tests", description: "cover edge cases" }],
    update: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }],
  })
  ```
  - Statuses: `pending` → `in_progress` → `completed`; `deleted` removes a task.
  - Creates apply before updates. An unknown id or empty subject fails the whole call without changes.
  - A call with no arguments returns the current list.
- **Widget** — header with done / in progress / open counts, then up to 10 tasks: `✔` completed (dim, struck through), a spinner for in progress, `◻` pending. Over 10, the oldest completed tasks are hidden first, then `… and N more`. Descriptions are agent-only.
- **Auto-clear** — if every task is completed when you send your next prompt, the list is cleared.
- **Reminder** — while open tasks exist and `todo` has gone unused for 4 turns, one hidden `<system-reminder>` is appended to the next model request (not saved to the session). It fires again only after the tool is used.
- **`/todo clear`** removes all tasks; **`/todo completed`** removes completed tasks.

## Storage

State follows the active session branch: each `todo` tool result stores a snapshot in its `details`, and `/todo` commands and auto-clear append a `todo` custom entry. On session start and `/tree` navigation the latest snapshot on the branch is restored, so resume, fork, and tree navigation show the list as it was at that point. Nothing is written outside the session.
