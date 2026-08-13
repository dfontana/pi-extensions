import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import marketplace from "./index.ts";

interface BoundExtension {
  handlers: Map<string, (...args: any[]) => unknown>;
  command: { handler: (...args: any[]) => Promise<void> };
  execCalls: number;
  customCalls: number;
  notifications: string[];
  statuses: string[];
}

function writeConfig(cwd: string, value: unknown): void {
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "marketplace-config.json"), JSON.stringify(value));
}

function bind(exec: (...args: any[]) => Promise<unknown>): BoundExtension {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let command: BoundExtension["command"] | undefined;
  let execCalls = 0;
  let customCalls = 0;
  const notifications: string[] = [];
  const statuses: string[] = [];

  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, options: BoundExtension["command"]) {
      command = options;
    },
    exec(...args: any[]) {
      execCalls += 1;
      return exec(...args);
    },
  } as unknown as ExtensionAPI;

  marketplace(pi);

  assert.ok(command);
  return {
    handlers,
    command,
    get execCalls() {
      return execCalls;
    },
    get customCalls() {
      return customCalls;
    },
    set customCalls(value: number) {
      customCalls = value;
    },
    notifications,
    statuses,
  } as BoundExtension;
}

function context(cwd: string, mode: "tui" | "rpc", bound: BoundExtension) {
  return {
    cwd,
    mode,
    ui: {
      notify: (message: string) => bound.notifications.push(message),
      setStatus: (_id: string, status: string) => bound.statuses.push(status),
      custom: async () => {
        bound.customCalls += 1;
        throw new Error("custom UI should not be called in this test");
      },
    },
  };
}

describe("claude-marketplace index", () => {
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "claude-marketplace-index-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("defers config and clone startup until session_start and uses its cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-marketplace-index-cwd-"));
    let releaseClone!: () => void;
    const cloneStarted = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const bound = bind(async (_command: string, args: string[]) => {
      assert.equal(args[0], "clone");
      await cloneStarted;
      const root = join(agentDir, "marketplace-cache", "remote");
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      mkdirSync(join(root, "plugin", "skills"), { recursive: true });
      writeFileSync(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ plugins: [{ name: "plugin", source: "./plugin" }] }),
      );
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    writeConfig(cwd, {
      marketplaces: [{ name: "remote", source: "https://example.test/marketplace.git", plugins: ["plugin"] }],
      updateIntervalHours: 0,
    });

    assert.equal(bound.execCalls, 0, "factory must not start a clone");
    const sessionStart = bound.handlers.get("session_start");
    const resourcesDiscover = bound.handlers.get("resources_discover") as
      | ((event: unknown, ctx: unknown) => Promise<{ skillPaths?: string[] }>)
      | undefined;
    assert.ok(sessionStart);
    assert.ok(resourcesDiscover);

    await sessionStart({}, context(cwd, "rpc", bound));
    assert.equal(bound.execCalls, 1, "session_start should start the configured clone");

    let discovered = false;
    const discovery = resourcesDiscover({}, context(cwd, "rpc", bound)).then((result) => {
      discovered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(discovered, false, "resource discovery waits for the initial clone");

    releaseClone();
    const result = await discovery;
    assert.deepEqual(result, {
      skillPaths: [join(agentDir, "marketplace-cache", "remote", "plugin", "skills")],
    });

    rmSync(cwd, { recursive: true, force: true });
  });

  test("does not open the marketplace UI outside TUI mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-marketplace-index-cwd-"));
    writeConfig(cwd, {
      marketplaces: [{ name: "local", source: join(cwd, "marketplace"), plugins: ["plugin"] }],
    });
    const bound = bind(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    const sessionStart = bound.handlers.get("session_start");
    assert.ok(sessionStart);

    await sessionStart({}, context(cwd, "rpc", bound));
    await bound.command.handler("", context(cwd, "rpc", bound));

    assert.equal(bound.customCalls, 0);
    assert.deepEqual(bound.notifications, ["The marketplace manager is only available in TUI mode."]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("uses CONFIG_DIR_NAME in the setup message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-marketplace-index-cwd-"));
    const bound = bind(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    const sessionStart = bound.handlers.get("session_start");
    assert.ok(sessionStart);

    await sessionStart({}, context(cwd, "tui", bound));
    await bound.command.handler("", context(cwd, "tui", bound));

    assert.match(bound.notifications[0] ?? "", new RegExp(`${CONFIG_DIR_NAME}/marketplace-config\\.json`));
    assert.equal(bound.customCalls, 0);
    rmSync(cwd, { recursive: true, force: true });
  });
});
