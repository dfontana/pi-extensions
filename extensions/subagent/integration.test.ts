// Opt-in: PI_RPC_INTEGRATION=1 npm test
// Runs the repository's Pi CLI in RPC mode against a local fake provider.
// No network or paid model calls; config, auth, and sessions live in a temp dir.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { turnCollector } from "./fake-rpc.ts";
import { prepareLaunch, type LaunchSession } from "./launch.ts";
import { finalOutput, resultOutput } from "./process.ts";
import { RpcWorker, runPiSubagent } from "./worker.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const hooks = {
  cliPath: join(here, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  extraArgs: ["--no-extensions", "--extension", join(here, "test-fixtures/fake-provider.ts")],
};
const agent = { name: "General", description: "General", systemPrompt: "Be brief.", filePath: "/tmp/general.md" };

describe("subagent integration", { skip: process.env.PI_RPC_INTEGRATION !== "1" && "set PI_RPC_INTEGRATION=1" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-it-"));
  const environment = { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" };
  after(() => rmSync(root, { recursive: true, force: true }));

  async function vibeWorker(session: LaunchSession) {
    const launch = await prepareLaunch({ agent, cwd: root, model: "probe/fake", environment, session }, hooks);
    const collector = turnCollector();
    const worker = new RpcWorker({ launch, identity: { agent: agent.name, task: "", cwd: root }, onTurnEnd: collector.onTurnEnd });
    await worker.start();
    return { worker, ...collector };
  }

  it("runs one synchronous task through a real RPC child", async () => {
    const result = await runPiSubagent({ agent, task: "say hi", cwd: root, model: "probe/fake", environment }, hooks);
    assert.equal(result.status, "done", result.stderr);
    assert.equal(resultOutput(result), "fake reply: Task: say hi");
    assert.equal(result.usage.turns, 1);
  });

  it("steers a running worker, starts turns from idle, and resumes after restart", async () => {
    const first = await vibeWorker({ kind: "new", directory: join(root, "workers", "w1"), id: randomUUID() });
    const start = await first.worker.send("start");
    const steer = await first.worker.send("mid-run correction");
    assert.deepEqual([start.outcome, steer.outcome], ["started", "steered"]);
    await first.count(1);
    assert.match(finalOutput(first.turns[0].result.messages), /mid-run correction/);

    assert.equal((await first.worker.send("after idle")).outcome, "started");
    await first.count(2);
    const { sessionFile, sessionId } = first.worker;
    await first.worker.stop();

    const resumed = await vibeWorker({ kind: "resume", file: sessionFile! });
    assert.equal(resumed.worker.sessionId, sessionId);
    const messages = await resumed.worker.transport.request({ type: "get_messages" });
    assert.ok(messages.data.messages.filter((message: any) => message.role === "user").length >= 3);
    assert.equal((await resumed.worker.send("continue")).outcome, "started");
    await resumed.count(1);
    await resumed.worker.stop();
  });
});
