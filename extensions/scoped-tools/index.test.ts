import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import scopedTools, { substitute } from "./index.ts";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
}

// Real subprocess execution standing in for pi.exec, matching its contract.
function exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolvePromise({ stdout, stderr, code, killed: Boolean(error?.killed) });
    });
  });
}

/** Write a project config, bind the extension, and fire session_start. */
async function start(spec: Record<string, unknown>) {
  const agentDir = mkdtempSync(join(tmpdir(), "scoped-tools-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "scoped-tools-cwd-"));
  mkdirSync(join(cwd, CONFIG_DIR_NAME));
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "scoped-tools.yaml"), stringify(spec));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const warnings: string[] = [];
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      events.set(event, handler);
    },
    exec,
  } as unknown as ExtensionAPI;
  scopedTools(api);

  const ctx = {
    cwd,
    signal: undefined,
    ui: { notify: (message: string) => warnings.push(message) },
  } as any;
  await events.get("session_start")!({}, ctx);

  const call = (name: string, params: Record<string, unknown>) =>
    tools.get(name)!.execute("id", params, undefined, undefined, ctx);
  return { tools, warnings, call };
}

const text = async (result: Promise<{ content: Array<{ text: string }> }>) => (await result).content[0].text;

describe("scoped-tools", () => {
  it("registers configured tools and substitutes parameters into the command", async () => {
    const { tools, call } = await start({
      greet: {
        description: "Greets someone",
        parameters: {
          name: { type: "string", description: "who" },
          count: { type: "number", description: "how many" },
        },
        commandTemplate: 'echo "hello $NAME x$COUNT"',
      },
    });
    const tool = tools.get("greet");
    assert.ok(tool, "tool registered from project config");
    assert.equal(tool.description, "Greets someone");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["count", "name"]);
    assert.equal(await text(call("greet", { name: "world", count: 2 })), "hello world x2");
  });

  it("rejects parameter values whose validationCmd fails, with its stderr", async () => {
    const { call } = await start({
      deploy: {
        description: "Deploy",
        parameters: {
          env: {
            type: "string",
            description: "environment",
            validationCmd: 'echo "$1" | grep -qxE "dev|prod" || { echo "env must be dev or prod" >&2; exit 1; }',
          },
        },
        commandTemplate: 'echo "deploying to $ENV"',
      },
    });
    await assert.rejects(call("deploy", { env: "staging" }), /Invalid value for parameter "env": env must be dev or prod/);
    assert.equal(await text(call("deploy", { env: "prod" })), "deploying to prod");
  });

  it("resolves hidden parameters from tool arguments without exposing them in the schema", async () => {
    const { tools, call } = await start({
      fetch_data: {
        description: "Fetch",
        parameters: { profile: { type: "string", description: "profile" } },
        hiddenParameters: {
          token: { valueFromCmd: 'echo "tok-$PROFILE"' },
          header: { valueFromCmd: 'echo "auth=$TOKEN"' },
        },
        commandTemplate: 'echo "$HEADER for $PROFILE"',
      },
    });
    assert.deepEqual(Object.keys(tools.get("fetch_data")!.parameters.properties), ["profile"]);
    assert.equal(await text(call("fetch_data", { profile: "qa" })), "auth=tok-qa for qa");
  });

  it("fails the call when a hidden parameter command fails", async () => {
    const { call } = await start({
      broken: {
        description: "Broken",
        hiddenParameters: { token: { valueFromCmd: "echo no session >&2; exit 4" } },
        commandTemplate: "echo $TOKEN",
      },
    });
    await assert.rejects(call("broken", {}), /Failed to resolve parameter "token": no session/);
  });

  it("returns stdout plus marked stderr on success, and throws stderr on failure", async () => {
    const { call } = await start({
      noisy: { description: "Noisy", commandTemplate: "echo out; echo warn >&2" },
      failing: { description: "Failing", commandTemplate: "echo boom >&2; exit 3" },
      silent: { description: "Silent", commandTemplate: "true" },
    });
    assert.equal(await text(call("noisy", {})), "out\n[stderr]\nwarn");
    await assert.rejects(call("failing", {}), /Command failed \(exit 3\): boom/);
    assert.equal(await text(call("silent", {})), "(no output)");
  });

  it("leaves unmatched $NAMES alone so templates can use environment variables", async () => {
    process.env.SCOPED_TOOLS_TEST_ENV = "from-env";
    const { call } = await start({
      env_echo: { description: "Env", commandTemplate: 'echo "$SCOPED_TOOLS_TEST_ENV"' },
    });
    assert.equal(await text(call("env_echo", {})), "from-env");
  });

  it("warns about invalid definitions instead of registering them", async () => {
    const { tools, warnings } = await start({ bad: { description: "no template" } });
    assert.equal(tools.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scoped-tools: skipped tool "bad"/);
  });
});

describe("scoped-tools substitute", () => {
  it("substitutes raw values, longest name first, leaving unknown names intact", () => {
    const values = { FOO: "a b", FOO_BAR: "--flag 'x'" };
    assert.equal(substitute("run $FOO_BAR $FOO $FOOD $other", values), "run --flag 'x' a b $FOOD $other");
  });
});
