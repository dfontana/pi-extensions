import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { loadScopedTools } from "./config.ts";

function fixture(global?: unknown, project?: unknown) {
  const agentDir = mkdtempSync(join(tmpdir(), "scoped-tools-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "scoped-tools-cwd-"));
  if (global !== undefined) {
    const body = typeof global === "string" ? global : stringify(global);
    writeFileSync(join(agentDir, "scoped-tools.yaml"), body);
  }
  if (project !== undefined) {
    mkdirSync(join(cwd, CONFIG_DIR_NAME));
    const body = typeof project === "string" ? project : stringify(project);
    writeFileSync(join(cwd, CONFIG_DIR_NAME, "scoped-tools.yaml"), body);
  }
  return loadScopedTools(cwd, agentDir);
}

const tool = (commandTemplate: string, extra: Record<string, unknown> = {}) => ({
  description: "a tool",
  commandTemplate,
  ...extra,
});

describe("scoped-tools config", () => {
  it("returns nothing when no config files exist", () => {
    const { tools, errors } = fixture();
    assert.deepEqual(tools, []);
    assert.deepEqual(errors, []);
  });

  it("merges global and project files with project winning per tool name", () => {
    const { tools, errors } = fixture(
      { alpha: tool("echo global-alpha"), beta: tool("echo global-beta") },
      { beta: tool("echo project-beta"), gamma: tool("echo gamma") },
    );
    assert.deepEqual(errors, []);
    const byName = new Map(tools.map((t) => [t.name, t.commandTemplate]));
    assert.equal(byName.get("alpha"), "echo global-alpha");
    assert.equal(byName.get("beta"), "echo project-beta");
    assert.equal(byName.get("gamma"), "echo gamma");
  });

  it("normalizes optional sections and keeps timeout", () => {
    const { tools, errors } = fixture(undefined, {
      deploy: tool("run $TARGET --auth $TOKEN", {
        timeout: 30,
        parameters: { target: { type: "string", description: "target", validationCmd: "true" } },
        hiddenParameters: { token: { valueFromCmd: "echo t" } },
      }),
    });
    assert.deepEqual(errors, []);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].timeout, 30);
    assert.equal(tools[0].parameters.target.validationCmd, "true");
    assert.equal(tools[0].hiddenParameters.token.valueFromCmd, "echo t");
  });

  it("skips invalid definitions with an error while keeping valid ones", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ bad: { description: "x" } }, /missing commandTemplate/],
      [{ bad: tool("echo", { parameters: { p: { type: "boolean", description: "d" } } }) }, /"string" or "number"/],
      [{ bad: tool("echo", { parameters: { foo: { type: "string", description: "d" }, FOO: { type: "string", description: "d" } } }) }, /collides/],
      [{ bad: tool("echo", { hiddenParameters: { h: {} } }) }, /valueFromCmd/],
      [{ bad: tool("echo", { timeout: -1 }) }, /timeout/],
      [{ "bad name!": tool("echo") }, /tool name/],
    ];
    for (const [definition, message] of cases) {
      const { tools, errors } = fixture(undefined, { ...definition, good: tool("echo ok") });
      assert.equal(tools.length, 1, `only the valid tool survives for ${message}`);
      assert.equal(tools[0].name, "good");
      assert.equal(errors.length, 1);
      assert.match(errors[0], message);
    }
  });

  it("reports unparseable files but still loads the other file", () => {
    const { tools, errors } = fixture("{not yaml", { solo: tool("echo hi") });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "solo");
    assert.equal(errors.length, 1);
  });

  it("parses YAML block scalars for multi-line command templates", () => {
    const { tools, errors } = fixture(undefined, `report:
  description: Run a readable pipeline
  commandTemplate: |
    printf '%s\\n' "$VALUE" |
      tr '[:lower:]' '[:upper:]'
  parameters:
    value:
      type: string
      description: Input to transform
`);
    assert.deepEqual(errors, []);
    assert.equal(tools[0].commandTemplate, "printf '%s\\n' \"$VALUE\" |\n  tr '[:lower:]' '[:upper:]'\n");
  });
});
