import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todo, { MAX_VISIBLE, REMINDER, REMINDER_TURNS, type TodoState } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => `~${text}~`,
};

/** A fake host that persists tool results and custom entries on one branch, like pi's session. */
function host() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  let tool: any;
  const branch: any[] = [];
  const notes: string[] = [];
  let widget: ((tui: any, theme: any) => any) | undefined;

  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (def: any) => (tool = def),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  todo(pi);

  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      setWidget: (_key: string, factory: any) => (widget = factory),
      notify: (msg: string) => notes.push(msg),
    },
  };

  const fire = (event: string, payload: any = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx);

  return {
    branch,
    notes,
    fire,
    async call(params: any) {
      const result = await tool.execute("id", params, undefined, undefined, ctx);
      branch.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: result.details } });
      return result as { content: { text: string }[]; details: TodoState };
    },
    command: (args: string) => commands.get("todo").handler(args, ctx),
    completions: (prefix: string) => commands.get("todo").getArgumentCompletions(prefix),
    /** Rendered widget lines, or undefined when no widget is mounted. */
    widget(width = 200) {
      if (!widget) return undefined;
      const component = widget({ requestRender() {} }, theme);
      const lines = component.render(width);
      component.dispose?.();
      return lines as string[];
    },
  };
}

const statuses = (s: TodoState) => s.tasks.map((t) => `${t.id}:${t.status}`);

describe("todo", () => {
  test("creates and updates tasks in one batch and echoes the full list", async () => {
    const h = host();
    const r1 = await h.call({ create: [{ subject: "Write tests", description: "cover edge cases" }, { subject: "Ship" }] });
    assert.deepEqual(statuses(r1.details), ["1:pending", "2:pending"]);
    assert.match(r1.content[0].text, /#1 \[pending\] Write tests\n {4}cover edge cases/);

    const r2 = await h.call({
      create: [{ subject: "Docs" }],
      update: [
        { id: 1, status: "completed" },
        { id: 2, status: "in_progress", subject: "Ship it", description: "tag release" },
        { id: 3, status: "deleted" },
      ],
    });
    assert.deepEqual(statuses(r2.details), ["1:completed", "2:in_progress"]);
    assert.equal(r2.details.tasks[1].subject, "Ship it");
    assert.equal(r2.details.nextId, 4, "ids are not reused after delete");

    const r3 = await h.call({});
    assert.match(r3.content[0].text, /#2 \[in_progress\] Ship it\n {4}tag release/);
  });

  for (const [name, params] of [
    ["unknown id", { update: [{ id: 99, status: "completed" }] }],
    ["empty subject on create", { create: [{ subject: "  " }] }],
    ["empty subject on update", { update: [{ id: 1, subject: "" }] }],
    ["update after delete in same batch", { update: [{ id: 1, status: "deleted" }, { id: 1, status: "completed" }] }],
  ] as const) {
    test(`rejects ${name} atomically`, async () => {
      const h = host();
      await h.call({ create: [{ subject: "A" }] });
      await assert.rejects(h.call({ create: [{ subject: "B" }], ...params }));
      const after = await h.call({});
      assert.deepEqual(statuses(after.details), ["1:pending"]);
    });
  }

  test("restores the latest snapshot from the active branch, including command entries", async () => {
    const h = host();
    await h.call({ create: [{ subject: "A" }, { subject: "B" }] });
    await h.call({ update: [{ id: 1, status: "completed" }] });
    await h.command("completed");

    const fresh = host();
    fresh.branch.push(...h.branch);
    await fresh.fire("session_start", { reason: "resume" });
    assert.deepEqual(statuses((await fresh.call({})).details), ["2:pending"]);

    // Navigating to an earlier point restores that point's state.
    fresh.branch.splice(1);
    await fresh.fire("session_tree");
    assert.deepEqual(statuses((await fresh.call({})).details), ["1:pending", "2:pending"]);
  });

  test("/todo clear and /todo completed persist entries and report counts", async () => {
    const h = host();
    await h.call({ create: [{ subject: "A" }, { subject: "B" }, { subject: "C" }] });
    await h.call({ update: [{ id: 1, status: "completed" }, { id: 2, status: "completed" }] });

    await h.command("completed");
    assert.deepEqual(statuses(h.branch.at(-1).data), ["3:pending"]);
    await h.command("clear");
    assert.deepEqual(h.branch.at(-1).data, { tasks: [], nextId: 1 });
    assert.deepEqual(h.notes.slice(0, 2), ["Removed 2 completed tasks", "Removed 1 task"]);
    assert.equal(h.widget(), undefined);

    await h.command("bogus");
    assert.match(h.notes.at(-1)!, /Usage/);
    assert.deepEqual(h.completions("c").map((c: any) => c.value), ["clear", "completed"]);
  });

  test("an all-completed list stays visible until the next prompt, then clears", async () => {
    const h = host();
    await h.call({ create: [{ subject: "A" }] });
    await h.fire("before_agent_start");
    assert.ok(h.widget(), "open tasks are not cleared");

    await h.call({ update: [{ id: 1, status: "completed" }] });
    assert.match(h.widget()!.join("\n"), /~#1 A~/);
    await h.fire("before_agent_start");
    assert.equal(h.widget(), undefined);
    assert.deepEqual(h.branch.at(-1).data, { tasks: [], nextId: 1 });
  });

  test("widget shows status markers and caps at 10, hiding completed tasks first", async () => {
    const h = host();
    const subjects = Array.from({ length: 13 }, (_, i) => ({ subject: `T${i + 1}` }));
    await h.call({ create: subjects });
    await h.call({ update: [1, 2, 3, 4].map((id) => ({ id, status: "completed" })).concat([{ id: 5, status: "in_progress" }]) });

    const lines = h.widget()!;
    assert.equal(lines[0], "● 13 tasks (4 done, 1 in progress, 8 open)");
    assert.equal(lines.length, 1 + MAX_VISIBLE + 1);
    assert.equal(lines[1], "  ✔ ~#4 T4~", "the three oldest completed tasks are hidden");
    assert.match(lines[2], /^ {2}\S #5 T5$/);
    assert.doesNotMatch(lines[2], /◻/);
    assert.equal(lines[3], "  ◻ #6 T6");
    assert.equal(lines.at(-1), "    … and 3 more");
  });

  test("reminds once after idle turns while tasks are open, never when all are done", async () => {
    const h = host();
    const ask = async () => (await h.fire("context", { messages: [] })) as { messages: any[] } | undefined;
    const idle = async (n: number) => {
      for (let i = 0; i < n; i++) await h.fire("turn_start");
    };

    await h.call({ create: [{ subject: "A" }] });
    await idle(REMINDER_TURNS - 1);
    assert.equal(await ask(), undefined);
    await idle(1);
    assert.equal((await ask())?.messages.at(-1).content[0].text, REMINDER);
    await idle(REMINDER_TURNS);
    assert.equal(await ask(), undefined, "only once per idle stretch");

    await h.call({ update: [{ id: 1, status: "completed" }] });
    await idle(REMINDER_TURNS);
    assert.equal(await ask(), undefined, "no open tasks");
  });
});
