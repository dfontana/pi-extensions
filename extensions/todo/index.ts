/**
 * todo — a minimal session-backed task list for the agent.
 *
 * - One `todo` tool creates and updates tasks in a single call.
 * - State lives only in the session: every tool result carries a snapshot in
 *   `details`, and `/todo` commands append a `todo` custom entry. The latest
 *   snapshot on the active branch wins, so resume, /tree, and fork just work.
 * - A widget above the editor shows up to 10 tasks; a list whose tasks are
 *   all completed clears itself when the user sends the next prompt.
 * - While open tasks exist and the tool has gone unused for a few turns, one
 *   transient reminder is appended to the next model request.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { compactRow, SPINNER_FRAMES, summary } from "../shared/tool-row.ts";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  status: TaskStatus;
}

export interface TodoState {
  tasks: Task[];
  nextId: number;
}

interface TodoParams {
  create?: { subject: string; description?: string }[];
  update?: {
    id: number;
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
  }[];
}

const NAME = "todo";
export const MAX_VISIBLE = 10;
/** Turns without a `todo` call, while tasks are open, before the reminder fires. */
export const REMINDER_TURNS = 4;
const SPINNER_INTERVAL_MS = 80;

export const REMINDER = `<system-reminder>
The todo tool hasn't been used recently and there are open tasks. If you have made progress, update their status (in_progress when starting, completed when done, deleted if obsolete). Ignore this if it isn't relevant, and never mention this reminder to the user.
</system-reminder>`;

const empty = (): TodoState => ({ tasks: [], nextId: 1 });

function isState(value: unknown): value is TodoState {
  const v = value as TodoState | undefined;
  return !!v && Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/** Latest snapshot on the active branch, from tool results or command entries. */
export function stateFromBranch(entries: readonly any[]): TodoState {
  let state = empty();
  for (const entry of entries) {
    let snapshot: unknown;
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === NAME) {
      snapshot = entry.message.details;
    } else if (entry.type === "custom" && entry.customType === NAME) {
      snapshot = entry.data;
    }
    if (isState(snapshot)) state = snapshot;
  }
  return state;
}

/** Apply a batch atomically: creates first, then updates. Throws without side effects on invalid input. */
export function applyOps(state: TodoState, params: TodoParams): TodoState {
  const tasks = state.tasks.map((t) => ({ ...t }));
  let nextId = state.nextId;
  for (const c of params.create ?? []) {
    const subject = c.subject?.trim();
    if (!subject) throw new Error("create: subject must not be empty");
    tasks.push({ id: nextId++, subject, ...(c.description ? { description: c.description } : {}), status: "pending" });
  }
  const deleted = new Set<number>();
  for (const u of params.update ?? []) {
    const task = tasks.find((t) => t.id === u.id);
    if (!task || deleted.has(u.id)) throw new Error(`update: task #${u.id} not found`);
    if (u.subject !== undefined) {
      if (!u.subject.trim()) throw new Error(`update: subject for #${u.id} must not be empty`);
      task.subject = u.subject.trim();
    }
    if (u.description !== undefined) {
      if (u.description) task.description = u.description;
      else delete task.description;
    }
    if (u.status === "deleted") deleted.add(u.id);
    else if (u.status) task.status = u.status;
  }
  return { tasks: tasks.filter((t) => !deleted.has(t.id)), nextId };
}

/** Text the agent sees after every call: the whole current list. */
export function formatList(state: TodoState): string {
  if (state.tasks.length === 0) return "No tasks.";
  return state.tasks
    .map((t) => `#${t.id} [${t.status}] ${t.subject}${t.description ? `\n    ${t.description.replace(/\n/g, "\n    ")}` : ""}`)
    .join("\n");
}

function counts(tasks: readonly Task[]) {
  const n = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  return { done: n("completed"), active: n("in_progress"), open: n("pending") };
}

const allDone = (state: TodoState) => state.tasks.length > 0 && state.tasks.every((t) => t.status === "completed");
const hasOpen = (state: TodoState) => state.tasks.some((t) => t.status !== "completed");

/** Up to MAX_VISIBLE tasks in id order, hiding the oldest completed tasks first. */
export function visibleTasks(tasks: readonly Task[]): Task[] {
  let excess = tasks.length - MAX_VISIBLE;
  if (excess <= 0) return [...tasks];
  const hidden = new Set<number>();
  for (const t of tasks) {
    if (excess === 0) break;
    if (t.status === "completed") {
      hidden.add(t.id);
      excess--;
    }
  }
  return tasks.filter((t) => !hidden.has(t.id)).slice(0, MAX_VISIBLE);
}

type WidgetTheme = Pick<Theme, "fg" | "strikethrough">;

export function renderWidget(state: TodoState, theme: WidgetTheme, width: number, frame = 0): string[] {
  const { tasks } = state;
  if (tasks.length === 0) return [];
  const { done, active, open } = counts(tasks);
  const parts = [done && `${done} done`, active && `${active} in progress`, open && `${open} open`].filter(Boolean);
  const lines = [theme.fg("accent", `● ${tasks.length} tasks (${parts.join(", ")})`)];
  const visible = visibleTasks(tasks);
  for (const t of visible) {
    const id = `#${t.id}`;
    if (t.status === "completed") {
      lines.push(`  ${theme.fg("success", "✔")} ${theme.fg("dim", theme.strikethrough(`${id} ${t.subject}`))}`);
    } else if (t.status === "in_progress") {
      const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      lines.push(`  ${theme.fg("accent", spin)} ${theme.fg("dim", id)} ${theme.fg("accent", t.subject)}`);
    } else {
      lines.push(`  ◻ ${theme.fg("dim", id)} ${t.subject}`);
    }
  }
  const more = tasks.length - visible.length;
  if (more > 0) lines.push(theme.fg("dim", `    … and ${more} more`));
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** Widget component; animates only while mounted and a task is in progress. */
class TodoWidget implements Component {
  private tick: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getState: () => TodoState,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    if (state.tasks.some((t) => t.status === "in_progress") && !this.tick) {
      this.tick = setTimeout(() => {
        this.tick = undefined;
        this.tui.requestRender();
      }, SPINNER_INTERVAL_MS);
      this.tick.unref?.();
    }
    return renderWidget(state, this.theme, width, Math.floor(Date.now() / SPINNER_INTERVAL_MS));
  }

  invalidate(): void {}

  dispose(): void {
    clearTimeout(this.tick);
    this.tick = undefined;
  }
}

const row = compactRow<TodoParams, TodoState>({
  name: NAME,
  details: (result) => (isState(result.details) ? result.details : undefined),
  title: ({ args, details, status, theme }) => {
    const created = args.create?.length ?? 0;
    const updated = args.update?.length ?? 0;
    const c = details && counts(details.tasks);
    return [
      created > 0 && theme.fg("accent", `+${created}`),
      updated > 0 && theme.fg("dim", `~${updated}`),
      created === 0 && updated === 0 && theme.fg("dim", "list"),
      status === "success" && details && c && summary(theme, `${c.done}/${details.tasks.length} done`),
    ];
  },
});

export default function (pi: ExtensionAPI) {
  let state = empty();
  let turnsSinceUse = 0;
  let reminded = false;

  function show(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (state.tasks.length === 0) {
      ctx.ui.setWidget(NAME, undefined);
      return;
    }
    ctx.ui.setWidget(NAME, (tui, theme) => new TodoWidget(tui, theme, () => state), { placement: "aboveEditor" });
  }

  /** Commit a user-initiated change as a session entry. */
  function commit(next: TodoState, ctx: ExtensionContext) {
    state = next;
    pi.appendEntry<TodoState>(NAME, state);
    show(ctx);
  }

  function restore(ctx: ExtensionContext) {
    state = stateFromBranch(ctx.sessionManager.getBranch());
    turnsSinceUse = 0;
    reminded = false;
    show(ctx);
  }

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(NAME, undefined);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (allDone(state)) commit(empty(), ctx);
  });

  pi.on("turn_start", async () => {
    turnsSinceUse++;
  });

  pi.on("context", async (event) => {
    if (reminded || turnsSinceUse < REMINDER_TURNS || !hasOpen(state)) return;
    reminded = true;
    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: REMINDER }], timestamp: Date.now() },
      ],
    };
  });

  pi.registerTool({
    name: NAME,
    label: "Todo",
    description: `Track a task list for the current session, shown to the user in a widget. One call can create tasks and update existing ones; the result is always the full current list.

Use it for work with 3+ distinct steps, when the user gives several tasks, or when they ask for a todo list. Skip it for single, trivial, or purely conversational requests.

- create: new tasks (status pending). subject is a short imperative title; description holds detail and acceptance criteria.
- update: change status, subject, or description of a task by id. Status: pending → in_progress → completed; "deleted" removes an obsolete task.
- Call with no arguments to read the current list.

Creates apply before updates. An invalid update (unknown id, empty subject) fails the whole call without changes.`,
    promptSnippet: "Track multi-step work as a task list shown to the user",
    promptGuidelines: [
      "For multi-step work, use the todo tool to create tasks, mark one in_progress before starting it, and mark it completed as soon as it is done.",
      "Only mark a todo task completed when it is fully done; keep it in_progress if blocked, tests fail, or work is partial.",
    ],
    parameters: Type.Object({
      create: Type.Optional(
        Type.Array(
          Type.Object({
            subject: Type.String({ description: "Short imperative title, e.g. 'Fix login redirect'" }),
            description: Type.Optional(Type.String({ description: "Details and acceptance criteria" })),
          }),
          { description: "Tasks to add, in order" },
        ),
      ),
      update: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Number({ description: "Task id" }),
            status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
            subject: Type.Optional(Type.String()),
            description: Type.Optional(Type.String({ description: "Replacement description; empty string removes it" })),
          }),
          { description: "Changes to existing tasks" },
        ),
      ),
    }),
    executionMode: "sequential",
    ...row,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      turnsSinceUse = 0;
      reminded = false;
      state = applyOps(state, params as TodoParams);
      show(ctx);
      return { content: [{ type: "text", text: formatList(state) }], details: state };
    },
  });

  const subcommands = {
    clear: "Remove all tasks",
    completed: "Remove completed tasks",
  } as const;

  pi.registerCommand(NAME, {
    description: "Manage the todo list: clear | completed",
    getArgumentCompletions: (prefix) =>
      Object.entries(subcommands)
        .filter(([value]) => value.startsWith(prefix.trim()))
        .map(([value, description]) => ({ value, label: value, description })),
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "clear") {
        const n = state.tasks.length;
        commit(empty(), ctx);
        ctx.ui.notify(`Removed ${n} task${n === 1 ? "" : "s"}`, "info");
      } else if (sub === "completed") {
        const remaining = state.tasks.filter((t) => t.status !== "completed");
        const n = state.tasks.length - remaining.length;
        commit(remaining.length ? { ...state, tasks: remaining } : empty(), ctx);
        ctx.ui.notify(`Removed ${n} completed task${n === 1 ? "" : "s"}`, "info");
      } else {
        ctx.ui.notify("Usage: /todo clear | /todo completed", "warning");
      }
    },
  });
}
