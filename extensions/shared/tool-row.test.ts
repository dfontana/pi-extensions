import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { compactRow, SPINNER_FRAMES, summary } from "./tool-row.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface Args {
  query?: string;
}

interface Details {
  hits?: number;
  waiting?: boolean;
}

const row = compactRow<Args, Details>({
  name: "demo",
  title: ({ args, details, status, theme: t }) => [
    args.query && `"${args.query}"`,
    status === "success" && details?.hits !== undefined && summary(t, `${details.hits} hits`),
  ],
  queued: (details) => details?.waiting === true,
});

function context(state: Record<string, unknown>, overrides: Partial<{ isPartial: boolean; isError: boolean; expanded: boolean }> = {}) {
  return {
    args: { query: "pi extensions" },
    state,
    lastComponent: undefined,
    invalidate() {},
    isPartial: false,
    isError: false,
    expanded: false,
    ...overrides,
  };
}

function result(text: string, details?: Details) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Render one pi pass (call slot, then result slot) and return both slots' lines. */
function pass(
  state: Record<string, unknown>,
  res: ReturnType<typeof result> | undefined,
  overrides: Partial<{ isPartial: boolean; isError: boolean; expanded: boolean }> = {},
  width = 120,
) {
  const ctx = context(state, overrides);
  const title = row.renderCall(ctx.args, theme, ctx);
  const body = res
    ? row.renderResult(res, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx)
    : undefined;
  return { title: title.render(width), body: body?.render(width) ?? [] };
}

describe("shared tool-row", () => {
  it("renders parameters, status, and a result summary on one title line with no collapsed body", () => {
    const cases = [
      { label: "running", overrides: { isPartial: true }, res: result("…"), icon: /demo [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] "pi extensions"$/ },
      { label: "queued", overrides: { isPartial: true }, res: result("…", { waiting: true }), icon: /^demo · "pi extensions"$/ },
      { label: "success", overrides: {}, res: result("answer", { hits: 3 }), icon: /^demo ✓ "pi extensions" → 3 hits$/ },
      { label: "error", overrides: { isError: true }, res: result("boom"), icon: /^demo ✗ "pi extensions"$/ },
    ];
    for (const { label, overrides, res, icon } of cases) {
      const { title, body } = pass({}, res, overrides);
      assert.equal(title.length, 1, label);
      assert.match(title[0], icon, label);
      assert.deepEqual(body, [], `${label}: collapsed rows have no body`);
    }
    assert.equal(SPINNER_FRAMES.length, 10);
  });

  it("truncates the collapsed title with ... and wraps it in full when expanded", () => {
    const state = {};
    const long = { query: "word ".repeat(40).trim() };
    const width = 40;
    const collapsedCtx = context(state);
    const collapsed = row.renderCall(long, theme, collapsedCtx).render(width);
    assert.equal(collapsed.length, 1);
    assert.ok(collapsed[0].replace(/\x1b\[[0-9;]*m/g, "").endsWith("..."));
    assert.ok(visibleWidth(collapsed[0]) <= width);

    const multiline = row.renderCall({ query: "first\nsecond" }, theme, context(state)).render(width);
    assert.deepEqual(multiline, ['demo ✓ "first second"']);

    const expanded = row.renderCall(long, theme, context(state, { expanded: true })).render(width);
    assert.ok(expanded.length > 1);
    assert.ok(expanded.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(expanded.join(" "), /\.\.\./);
    assert.equal(expanded.join(" ").replace(/\s+/g, " ").match(/word/g)?.length, 40);
  });

  it("shows the result on expanded success, the error on expanded failure, and nothing while running", () => {
    const cases = [
      { overrides: { expanded: true }, res: result("full answer"), expected: ["full answer"] },
      { overrides: { expanded: true, isError: true }, res: result("request failed (500)"), expected: ["request failed (500)"] },
      { overrides: { expanded: true, isError: true }, res: result(""), expected: ["demo failed"] },
      { overrides: { expanded: true, isPartial: true }, res: result("spinner text"), expected: [] },
    ];
    for (const { overrides, res, expected } of cases) {
      assert.deepEqual(pass({}, res, overrides).body.map((line) => line.trimEnd()), expected);
    }
  });

  it("uses a custom body when one is provided and keeps details across results without them", () => {
    const custom = compactRow<Args, Details>({
      name: "demo",
      title: ({ details }) => [details?.hits !== undefined && `${details.hits} hits`],
      body: ({ details, status }) => new Text(`${status}:${details?.hits}`, 0, 0),
    });
    const state = {};
    const ctx = context(state, { expanded: true });
    custom.renderResult(result("", { hits: 7 }), { expanded: true, isPartial: true }, theme, { ...ctx, isPartial: true });
    const failed = { ...ctx, isError: true };
    const body = custom.renderResult(result("thrown"), { expanded: true, isPartial: false }, theme, failed);
    assert.deepEqual(body.render(80).map((line) => line.trimEnd()), ["error:7"]);
    assert.match(custom.renderCall(ctx.args, theme, failed).render(80)[0], /^demo ✗ 7 hits$/);
  });

  it("degrades to the bare name when a title formatter throws, since the title renders outside pi's guard", () => {
    const broken = compactRow<Args>({ name: "demo", title: () => { throw new Error("partial args"); } });
    const ctx = context({});
    assert.deepEqual(broken.renderCall(undefined as unknown as Args, theme, ctx).render(80), ["demo ✓"]);
  });
});

