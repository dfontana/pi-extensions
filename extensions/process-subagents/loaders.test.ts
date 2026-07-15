import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentDefinitions, loadSubagentConfig } from "./loaders.ts";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-loaders-"));
}

describe("process-subagents loaders", () => {
  test("loads built-ins and lets trusted project definitions replace lower precedence", () => {
    const cwd = tempProject();
    try {
      fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "Explore.md"), `---\ndescription: Project explorer\ndisplay_name: Project Explore\ntools: read, bash\nrun_in_background: true\n---\nProject-only prompt.\n`);
      const trusted = loadAgentDefinitions(cwd, true, path.join(cwd, "global")).get("Explore");
      assert.equal(trusted?.displayName, "Project Explore");
      assert.deepEqual(trusted?.tools, ["read", "bash"]);
      assert.equal(trusted?.runInBackground, true);
      assert.equal(loadAgentDefinitions(cwd, false, path.join(cwd, "global")).get("Explore")?.source, "builtin");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test("rejects unknown definition keys with the source path", () => {
    const cwd = tempProject();
    const file = path.join(cwd, ".pi", "agents", "Bad.md");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ndescription: bad\nunknown: true\n---\nprompt\n`);
      assert.throws(() => loadAgentDefinitions(cwd, true, path.join(cwd, "global")), (error: Error) => error.message.includes(file) && error.message.includes("unknown"));
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test("merges trusted project config and model aliases", () => {
    const cwd = tempProject();
    try {
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "subagents.json"), JSON.stringify({
        maxConcurrentAgents: 2,
        idleWarningMs: 10,
        widgetMaxRows: 1,
        defaultBackground: true,
        modelAliases: { fast: "provider/model" },
      }));
      const config = loadSubagentConfig(cwd, true, path.join(cwd, "global"));
      assert.equal(config.maxConcurrentAgents, 2);
      assert.equal(config.defaultBackground, true);
      assert.equal(config.modelAliases.fast, "provider/model");
      assert.equal(loadSubagentConfig(cwd, false, path.join(cwd, "global")).maxConcurrentAgents, 4);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test("rejects malformed config values", () => {
    const cwd = tempProject();
    const file = path.join(cwd, ".pi", "subagents.json");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ maxConcurrentAgents: 0 }));
      assert.throws(() => loadSubagentConfig(cwd, true, path.join(cwd, "global")), (error: Error) => error.message.includes(file));
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
