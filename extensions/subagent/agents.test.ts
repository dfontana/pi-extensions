import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverAgents } from "./agents.ts";

function tempAgents() {
  return mkdtempSync(join(tmpdir(), "subagent-agents-"));
}

function definition(frontmatter: string, body = "System instructions.") {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe("subagent agents", () => {
  it("loads only top-level markdown files and parses optional defaults", () => {
    const directory = tempAgents();
    writeFileSync(
      join(directory, "scout.md"),
      definition(
        "name: scout\ndescription: Explore code\ntools: read, grep, find\nmodel: anthropic/claude-haiku-4-5\nthinking: low",
        "Be concise.",
      ),
    );
    writeFileSync(join(directory, "ignored.txt"), "not an agent");
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested", "worker.md"), definition("name: worker\ndescription: Work"));

    const result = discoverAgents(directory);
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.agents.slice(1), [
      {
        name: "scout",
        description: "Explore code",
        tools: ["read", "grep", "find"],
        model: "anthropic/claude-haiku-4-5",
        thinking: "low",
        systemPrompt: "Be concise.",
        filePath: join(directory, "scout.md"),
      },
    ]);
  });

  it("loads markdown symlinks", () => {
    const directory = tempAgents();
    const target = join(directory, "target.txt");
    writeFileSync(target, definition("name: linked\ndescription: Linked agent"));
    symlinkSync(target, join(directory, "linked.md"));

    assert.deepEqual(discoverAgents(directory).agents.map((agent) => agent.name), ["General", "linked"]);
  });

  it("skips malformed definitions with actionable diagnostics", () => {
    const directory = tempAgents();
    writeFileSync(join(directory, "missing.md"), definition("name: missing"));
    writeFileSync(join(directory, "thinking.md"), definition("name: thinker\ndescription: Think\nthinking: enormous"));
    writeFileSync(join(directory, "tools.md"), definition("name: tools\ndescription: Tools\ntools:\n  - read"));
    writeFileSync(join(directory, "valid.md"), definition("name: valid\ndescription: Valid"));

    const result = discoverAgents(directory);
    assert.deepEqual(result.agents.map((agent) => agent.name), ["General", "valid"]);
    assert.equal(result.diagnostics.length, 3);
    assert.match(result.diagnostics.map((item) => item.message).join("\n"), /name.*description/);
    assert.match(result.diagnostics.map((item) => item.message).join("\n"), /thinking.*off.*max/);
    assert.match(result.diagnostics.map((item) => item.message).join("\n"), /tools.*comma-separated/);
  });

  it("keeps the first duplicate name and diagnoses later definitions", () => {
    const directory = tempAgents();
    writeFileSync(join(directory, "a.md"), definition("name: same\ndescription: First"));
    writeFileSync(join(directory, "b.md"), definition("name: same\ndescription: Second"));

    const result = discoverAgents(directory);
    assert.equal(result.agents.find((agent) => agent.name === "same")?.description, "First");
    assert.match(result.diagnostics[0].message, /duplicate agent name 'same'/);
  });

  it("provides the built-in General agent when the global directory does not exist", () => {
    const directory = join(tempAgents(), "missing");
    const result = discoverAgents(directory);
    assert.equal(result.directory, directory);
    assert.deepEqual(result.agents.map((agent) => agent.name), ["General"]);
    assert.equal(result.diagnostics.length, 0);
  });

  it("lets a global General definition override the built-in fallback", () => {
    const directory = tempAgents();
    writeFileSync(join(directory, "General.md"), definition("name: General\ndescription: Custom general", "Custom."));
    const result = discoverAgents(directory);
    assert.equal(result.agents.filter((agent) => agent.name === "General").length, 1);
    assert.equal(result.agents.find((agent) => agent.name === "General")?.systemPrompt, "Custom.");
  });
});
