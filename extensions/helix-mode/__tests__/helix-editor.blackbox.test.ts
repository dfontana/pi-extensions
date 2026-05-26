import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createEditor,
  editorSnapshot,
  enterNormal,
  moveToCol,
  press,
  renderBody,
  repeatKey,
  typeText,
} from "./test-harness.js";

const WRAP_WIDTH = 32;
const WRAPPED_SENTENCE = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";

describe("HelixEditor black-box word wrapping", () => {
  it("reflows following visual lines upward while deleting one character at a time mid-sentence", () => {
    const { editor } = createEditor({ rows: 20 });
    typeText(editor, WRAPPED_SENTENCE);
    enterNormal(editor);
    moveToCol(editor, 12);

    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta gamma delta epsilon",
      "zeta eta theta iota kappa",
      "lambda mu",
    ]);

    const expectedAfterEachDelete = [
      [
        "alpha beta gmma delta epsilon",
        "zeta eta theta iota kappa",
        "lambda mu",
      ],
      [
        "alpha beta gma delta epsilon",
        "zeta eta theta iota kappa",
        "lambda mu",
      ],
      [
        "alpha beta ga delta epsilon",
        "zeta eta theta iota kappa",
        "lambda mu",
      ],
      [
        "alpha beta g delta epsilon",
        "zeta eta theta iota kappa",
        "lambda mu",
      ],
      [
        "alpha beta gdelta epsilon zeta",
        "eta theta iota kappa lambda mu",
      ],
    ];

    for (const expectedBody of expectedAfterEachDelete) {
      press(editor, "d");
      assert.deepEqual(renderBody(editor, WRAP_WIDTH), expectedBody);
    }
  });

  it("converges visually and logically for repeated delete vs deleting the same selection", () => {
    const repeated = createEditor({ rows: 20 }).editor;
    repeated.setText(WRAPPED_SENTENCE);
    enterNormal(repeated);
    moveToCol(repeated, 12);
    repeatKey(repeated, "d", 8);

    const selected = createEditor({ rows: 20 }).editor;
    selected.setText(WRAPPED_SENTENCE);
    enterNormal(selected);
    moveToCol(selected, 12);
    press(selected, "v");
    repeatKey(selected, "l", 7);
    press(selected, "d");

    assert.deepEqual(
      editorSnapshot(repeated, WRAP_WIDTH),
      editorSnapshot(selected, WRAP_WIDTH),
    );
    assert.deepEqual(renderBody(selected, WRAP_WIDTH), [
      "alpha beta gta epsilon zeta",
      "eta theta iota kappa lambda mu",
    ]);
  });

  it("pulls the next word up after deleting near a wrap opportunity", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText(WRAPPED_SENTENCE);
    enterNormal(editor);
    moveToCol(editor, 23);

    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta gamma delta epsilon",
      "zeta eta theta iota kappa",
      "lambda mu",
    ]);

    repeatKey(editor, "d", 5);

    assert.equal(editor.getText(), "alpha beta gamma delta on zeta eta theta iota kappa lambda mu");
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta gamma delta on zeta",
      "eta theta iota kappa lambda mu",
    ]);
  });

  it("reflows hard-wrap boundaries after deleting inside a word near the boundary", () => {
    const { editor } = createEditor({ rows: 20 });
    const text = "alpha beta boundarywordxyz omega theta iota kappa";
    editor.setText(text);
    enterNormal(editor);
    moveToCol(editor, 20);

    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta boundarywordxyz",
      "omega theta iota kappa",
    ]);

    repeatKey(editor, "d", 6);

    assert.equal(editor.getText(), "alpha beta boundaryw omega theta iota kappa");
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta boundaryw omega",
      "theta iota kappa",
    ]);
  });
});

describe("HelixEditor black-box edit commands", () => {
  it("normal-mode d deletes one character, then printable input is ignored until insert mode", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("abc def ghi");
    enterNormal(editor);
    moveToCol(editor, 1);

    press(editor, "d");
    assert.equal(editor.getText(), "ac def ghi");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["ac def ghi"]);

    press(editor, "Z");
    assert.equal(editor.getText(), "ac def ghi");

    press(editor, "i");
    typeText(editor, "X");
    assert.equal(editor.getText(), "aXc def ghi");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["aXc def ghi"]);
  });

  it("select-mode d deletes an inclusive selection and returns to normal-like behavior", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("abcdef ghij");
    enterNormal(editor);
    moveToCol(editor, 2);

    press(editor, "v");
    repeatKey(editor, "l", 2);
    press(editor, "d");

    assert.equal(editor.getText(), "abf ghij");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["abf ghij"]);

    press(editor, "Z");
    assert.equal(editor.getText(), "abf ghij");
  });

  it("c deletes a selection and inserts subsequent printable input at the deletion point", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("abcdef ghij");
    enterNormal(editor);
    moveToCol(editor, 2);

    press(editor, "v");
    repeatKey(editor, "l", 2);
    press(editor, "c");
    typeText(editor, "XYZ");

    assert.equal(editor.getText(), "abXYZf ghij");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["abXYZf ghij"]);
  });

  it("r<char> replaces the character under the cursor without entering insert mode", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha beta gamma delta epsilon zeta");
    enterNormal(editor);
    moveToCol(editor, 6);

    press(editor, "r", "B");
    assert.equal(editor.getText(), "alpha Beta gamma delta epsilon zeta");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha Beta gamma delta epsilon",
      "zeta",
    ]);

    press(editor, "z");
    assert.equal(editor.getText(), "alpha Beta gamma delta epsilon zeta");
  });

  it("d at the end of a logical line deletes the newline and rewraps the merged line", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha beta gamma\nzeta eta theta iota kappa");
    enterNormal(editor);
    press(editor, "g", "g", "$", "d");

    assert.equal(editor.getText(), "alpha beta gammazeta eta theta iota kappa");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 16 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta gammazeta eta theta",
      "iota kappa",
    ]);
  });
});

describe("HelixEditor black-box navigation assumptions", () => {
  it("0 and $ move to logical line start and end on a wrapped line", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha beta gamma delta epsilon zeta");
    enterNormal(editor);

    press(editor, "g", "g", "$");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 35 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha beta gamma delta epsilon",
      "zeta",
    ]);

    press(editor, "0");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("word motions use logical text positions rather than visual wrap boundaries", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha beta gamma delta epsilon zeta");
    enterNormal(editor);
    press(editor, "g", "g");

    press(editor, "w");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });

    press(editor, "e");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 9 });

    press(editor, "b");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
  });

  it("gg and ge navigate to buffer start and end across logical lines", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha beta gamma\ndelta epsilon zeta");
    enterNormal(editor);

    press(editor, "g", "g");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    press(editor, "g", "e");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 18 });
  });
});

describe("HelixEditor black-box gw labels", () => {
  it("shows two-character labels inline and jumps after typing both characters", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("the dog goes");
    enterNormal(editor);
    press(editor, "g", "g");

    press(editor, "g", "w");
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["aae abg aces"]);

    press(editor, "a");
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["aae abg aces"]);

    press(editor, "c");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["the dog goes"]);
  });

  it("does not offer labels for one-character words", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("a dog");
    enterNormal(editor);
    press(editor, "g", "g");

    press(editor, "g", "w");
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["a aag"]);

    press(editor, "a", "a");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), ["a dog"]);
  });
});

describe("HelixEditor black-box Unicode deletion", () => {
  it("single delete removes one emoji grapheme and rewraps", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha 🙂 beta gamma delta epsilon zeta");
    enterNormal(editor);
    moveToCol(editor, 6);

    press(editor, "d");

    assert.equal(editor.getText(), "alpha  beta gamma delta epsilon zeta");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha  beta gamma delta",
      "epsilon zeta",
    ]);
  });

  it("single delete removes one combining-character grapheme and rewraps", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha e\u0301 beta gamma delta epsilon zeta");
    enterNormal(editor);
    moveToCol(editor, 6);

    press(editor, "d");

    assert.equal(editor.getText(), "alpha  beta gamma delta epsilon zeta");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha  beta gamma delta",
      "epsilon zeta",
    ]);
  });

  it("single delete removes one wide CJK grapheme and rewraps", () => {
    const { editor } = createEditor({ rows: 20 });
    editor.setText("alpha 表 beta gamma delta epsilon zeta");
    enterNormal(editor);
    moveToCol(editor, 6);

    press(editor, "d");

    assert.equal(editor.getText(), "alpha  beta gamma delta epsilon zeta");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
    assert.deepEqual(renderBody(editor, WRAP_WIDTH), [
      "alpha  beta gamma delta",
      "epsilon zeta",
    ]);
  });
});
