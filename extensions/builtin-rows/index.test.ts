import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderRow, textResult } from "../shared/render-harness.ts";
import extension from "./index.ts";

function load(): ToolRendererResolver {
  let resolver: ToolRendererResolver | undefined;
  extension({ registerToolRenderer: (registered: ToolRendererResolver) => (resolver = registered) } as unknown as ExtensionAPI);
  assert.ok(resolver, "builtin-rows registers a tool renderer");
  return resolver;
}

/** Stands in for pi's stock renderers, which `next()` returns for built-in tools. */
const stock = (overrides: Partial<ToolRenderers> = {}): ToolRenderers => ({
  renderCall: () => new Text("STOCK CALL", 0, 0),
  renderResult: (result) => new Text(`STOCK RESULT ${(result.content[0] as { text: string }).text}`, 0, 0),
  ...overrides,
});

describe("builtin-rows", () => {
  it("draws built-in tools as one compact line, with pi's own rendering when expanded", () => {
    const rows = load();
    const cases = [
      { tool: "read", args: { path: "src/a.ts", offset: 2, limit: 5 }, title: "read ✓ offset=2 limit=5 src/a.ts" },
      { tool: "write", args: { path: "notes.txt", content: "a\nb\nc" }, title: "write ✓ 3 lines notes.txt" },
      { tool: "bash", args: { command: "sleep 3", timeout: 10 }, title: "bash ✓ timeout=10s sleep 3" },
      // Models sometimes send null for omitted optional parameters.
      { tool: "bash", args: { command: "ls", timeout: null }, title: "bash ✓ ls" },
      { tool: "read", args: { path: "a.ts", offset: null, limit: null }, title: "read ✓ a.ts" },
      { tool: "grep", args: { pattern: "todo", ignoreCase: true }, title: "grep ✓ todo ignoreCase ." },
      { tool: "find", args: { pattern: "*.ts", limit: 3 }, title: "find ✓ *.ts limit=3 ." },
      { tool: "ls", args: { path: "src" }, title: "ls ✓ src" },
    ];
    for (const { tool, args, title } of cases) {
      const renderers = rows(tool, () => stock())!;
      const collapsed = renderRow(renderers, args, textResult("ok"));
      assert.equal(collapsed.title, title, tool);
      assert.deepEqual(collapsed.body, [], `${tool} has no collapsed body`);

      const expanded = renderRow(renderers, args, textResult("ok"), { expanded: true });
      assert.deepEqual(expanded.body, ["STOCK CALL", "STOCK RESULT ok"], `${tool} expands to pi's rendering`);
    }
  });

  it("leaves pi's rendering alone when the compact row cannot wrap it", () => {
    const rows = load();
    const cases: Array<{ name: string; tool: string; next: ToolRenderers | undefined }> = [
      { name: "edit keeps its diff preview", tool: "edit", next: stock() },
      { name: "other tools", tool: "web_fetch", next: stock() },
      { name: "no renderers", tool: "read", next: undefined },
      { name: "no call renderer", tool: "read", next: stock({ renderCall: undefined }) },
      { name: "no result renderer", tool: "bash", next: stock({ renderResult: undefined }) },
      { name: "a custom shell", tool: "ls", next: stock({ renderShell: "self" }) },
    ];
    for (const { name, tool, next } of cases) assert.equal(rows(tool, () => next), next, name);
  });

  it("keeps the compact title when pi's renderers throw", () => {
    const rows = load();
    const boom = () => {
      throw new Error("renderer changed");
    };
    const renderers = rows("read", () => stock({ renderCall: boom, renderResult: boom }))!;
    const row = renderRow(renderers, { path: "a.ts" }, textResult("ok"), { expanded: true });
    assert.equal(row.title, "read ✓ a.ts");
  });
});
