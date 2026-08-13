import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { MarketplaceEntry } from "./config.ts";
import {
  ensureCloned,
  forcePull,
  marketplaceCacheDir,
  pullIfStale,
  type ExecRunner,
} from "./fetcher.ts";

interface Call {
  command: string;
  args: string[];
  options?: ExecOptions;
}

function fakeRunner(
  response: (call: Call, index: number) => Partial<ExecResult> = () => ({}),
): { calls: Call[]; runner: ExecRunner } {
  const calls: Call[] = [];
  const runner: ExecRunner = async (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    const result = response(call, calls.length - 1);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      killed: result.killed ?? false,
    };
  };
  return { calls, runner };
}

function entry(overrides: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    name: "test-marketplace",
    source: "https://example.test/marketplace.git",
    plugins: ["plugin"],
    ...overrides,
  };
}

describe("claude-marketplace fetcher", () => {
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "claude-marketplace-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("passes clone inputs as separate argv values", async () => {
    const source = "https://example.test/repo; touch injected";
    const branch = "release candidate && touch injected";
    const marketplace = entry({ name: "marketplace with spaces", source, branch });
    const { calls, runner } = fakeRunner();

    await ensureCloned(marketplace, runner);

    assert.deepEqual(calls, [{
      command: "git",
      args: [
        "clone",
        "--depth=1",
        "--branch",
        branch,
        "--",
        source,
        marketplaceCacheDir(marketplace.name),
      ],
      options: {
        cwd: join(agentDir, "marketplace-cache"),
        timeout: 120_000,
      },
    }]);
  });

  test("fetches before resetting and keeps the Git timeout", async () => {
    const marketplace = entry();
    mkdirSync(marketplaceCacheDir(marketplace.name), { recursive: true });
    const { calls, runner } = fakeRunner();

    await forcePull(marketplace, runner);

    assert.deepEqual(calls, [
      {
        command: "git",
        args: ["fetch", "--depth=1", "origin"],
        options: { cwd: marketplaceCacheDir(marketplace.name), timeout: 120_000 },
      },
      {
        command: "git",
        args: ["reset", "--hard", "FETCH_HEAD"],
        options: { cwd: marketplaceCacheDir(marketplace.name), timeout: 120_000 },
      },
    ]);
  });

  test("stops after a failed fetch and preserves the update error", async () => {
    const marketplace = entry();
    mkdirSync(marketplaceCacheDir(marketplace.name), { recursive: true });
    const { calls, runner } = fakeRunner(() => ({ code: 7, stderr: "remote unavailable" }));

    await assert.rejects(
      forcePull(marketplace, runner),
      /Failed to force-update marketplace "test-marketplace" from https:\/\/example\.test\/marketplace\.git:\ngit fetch failed \(exit 7\): remote unavailable/,
    );
    assert.equal(calls.length, 1);
  });

  test("wraps clone failures from the injected runner", async () => {
    const marketplace = entry({ name: "clone-failure" });
    const { runner } = fakeRunner(() => ({ code: 128, stderr: "repository not found" }));

    await assert.rejects(
      ensureCloned(marketplace, runner),
      /Failed to clone marketplace "clone-failure" from https:\/\/example\.test\/marketplace\.git:\ngit clone failed \(exit 128\): repository not found/,
    );
  });

  test("does not run Git for local sources", async () => {
    const marketplace = entry({ source: "./local-marketplace" });
    const { calls, runner } = fakeRunner();

    await ensureCloned(marketplace, runner);
    assert.equal(await pullIfStale(marketplace, 24, runner), false);
    await forcePull(marketplace, runner);

    assert.deepEqual(calls, []);
  });
});
