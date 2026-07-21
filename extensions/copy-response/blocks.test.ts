import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildCopyOptions, normalizeBlock, normalizeWhole, parseFences } from "./blocks.ts";

describe("copy-response blocks", () => {
  describe("normalizeBlock", () => {
    const cases: Array<{ name: string; input: string; expected: string }> = [
      {
        name: "dedents a uniformly over-indented block, preserving relative indent",
        input: "  graph TD\n    A --> B\n    B --> C",
        expected: "graph TD\n  A --> B\n  B --> C",
      },
      {
        name: "strips trailing whitespace on every line (no dedent; foo is at column 0)",
        input: "foo   \n  bar\t\n",
        expected: "foo\n  bar",
      },
      {
        name: "drops leading and trailing blank lines but keeps interior ones",
        input: "\n\n  a\n\n  b\n  \n",
        expected: "a\n\nb",
      },
      {
        name: "no dedent when any line sits at column zero",
        input: "top\n    nested",
        expected: "top\n    nested",
      },
      {
        name: "normalizes CRLF to LF",
        input: "a\r\n  b\r\n",
        expected: "a\n  b",
      },
      {
        name: "empty input yields empty string",
        input: "\n  \n",
        expected: "",
      },
    ];

    for (const { name, input, expected } of cases) {
      test(name, () => {
        assert.equal(normalizeBlock(input), expected);
      });
    }

    test("tab/space common prefix strips only the shared tab", () => {
      // Line A: <tab><tab>first ; Line B: <tab><space>second
      // Shared prefix is a single tab, so it is the only thing removed.
      assert.equal(normalizeBlock("\t\tfirst\n\t second"), "\tfirst\n second");
    });
  });

  describe("normalizeWhole", () => {
    test("trims edges and trailing whitespace but never dedents", () => {
      assert.equal(normalizeWhole("\nHere:   \n    indented code\n\n"), "Here:\n    indented code");
    });
  });

  describe("parseFences", () => {
    test("extracts fence content and language, excluding the fence lines", () => {
      const text = "before\n```ts\nconst x = 1;\n```\nafter";
      assert.deepEqual(parseFences(text), [{ lang: "ts", content: "const x = 1;" }]);
    });

    test("handles multiple fences and tilde fences", () => {
      const text = "```js\na\n```\ntext\n~~~\nb\n~~~";
      assert.deepEqual(parseFences(text), [
        { lang: "js", content: "a" },
        { lang: "", content: "b" },
      ]);
    });

    test("an unclosed fence runs to end of text", () => {
      const text = "```py\nx = 1\ny = 2";
      assert.deepEqual(parseFences(text), [{ lang: "py", content: "x = 1\ny = 2" }]);
    });

    test("a longer fence is not closed by a shorter run of the same char", () => {
      const text = "````\n```\ninner\n````";
      assert.deepEqual(parseFences(text), [{ lang: "", content: "```\ninner" }]);
    });
  });

  describe("buildCopyOptions", () => {
    test("no fences: only the entire-response option", () => {
      const options = buildCopyOptions("just prose\nover two lines");
      assert.equal(options.length, 1);
      assert.equal(options[0].label, "Entire response");
      assert.equal(options[0].content, "just prose\nover two lines");
      assert.equal(options[0].lineCount, 2);
    });

    test("multiple fences add per-block entries and an all-blocks entry", () => {
      const text = "intro\n```ts\n  const x = 1;\n```\nmid\n```bash\necho hi\n```";
      const options = buildCopyOptions(text);
      assert.deepEqual(
        options.map((o) => o.label),
        ["Entire response", "Block 1 · ts · 1 line", "Block 2 · bash · 1 line", "All code blocks"],
      );
      // Block 1 is dedented.
      assert.equal(options[1].content, "const x = 1;");
      // All-blocks joins normalized blocks with a blank line.
      assert.equal(options[3].content, "const x = 1;\n\necho hi");
    });

    test("fence with no language is labeled text", () => {
      const options = buildCopyOptions("```\nplain\n```");
      assert.equal(options[1].label, "Block 1 · text · 1 line");
    });
  });
});
