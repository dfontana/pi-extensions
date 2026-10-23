import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultHandler, fakeRpcSpawn, turnCollector, type FakeRpcChild } from "./fake-rpc.ts";
import { SubagentScheduler } from "./scheduler.ts";
import { RpcWorker } from "./worker.ts";

function startWorker(handler: (child: FakeRpcChild, command: any) => void, options: { requestTimeoutMs?: number; scheduler?: SubagentScheduler } = {}) {
  const fake = fakeRpcSpawn({ handler });
  const collector = turnCollector();
  const worker = new RpcWorker({
    launch: {
      command: "pi", args: [], cwd: "/tmp", env: {}, cleanup: async () => {},
      spawn: fake.spawn, requestTimeoutMs: options.requestTimeoutMs, shutdownGraceMs: 0, escalationDelayMs: 0,
    },
    identity: { agent: "General", task: "", cwd: "/tmp" },
    acquireTurn: options.scheduler && (() => options.scheduler!.acquireTurn()),
    onTurnEnd: collector.onTurnEnd,
  });
  const prompts = () => fake.children[0].commands.filter((command) => command.type === "prompt");
  return { worker, ...collector, prompts, child: () => fake.children[0] };
}

/** Prompts start a run that stays open; later prompts are queued steers the run picks up. */
function holdingHandler(child: FakeRpcChild, command: any) {
  if (command.type !== "prompt") return defaultHandler(child, command);
  const first = child.commands.filter((sent) => sent.type === "prompt")[0] === command;
  child.respond(command, { disposition: first ? "started" : "queued" });
  child.userMessage(command.message);
}

describe("subagent worker", () => {
  it("starts a turn when idle and steers the running turn at its next step", async () => {
    const { worker, turns, count, prompts, child } = startWorker(holdingHandler);
    await worker.start();
    const started = await worker.send("do the thing");
    const steered = await worker.send("also this");
    child().finishRun("both handled");
    await count(1);

    assert.deepEqual([started.outcome, steered.outcome], ["started", "steered"]);
    assert.equal(steered.turnId, started.turnId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, "completed");
    assert.equal(prompts()[0].streamingBehavior, "steer");
    assert.match(prompts()[0].message, /^<director-message id="dir_/);
    await worker.stop();
  });

  it("recovers a steer the run left in Pi's queue and starts the next turn with it", async () => {
    const { worker, turns, count, prompts, child } = startWorker((child, command) => {
      const sent = child.commands.filter((entry) => entry.type === "prompt");
      if (command.type === "prompt" && sent.length === 1) {
        child.respond(command, { disposition: "started" });
        child.userMessage(command.message);
      } else if (command.type === "prompt" && sent.length === 2) {
        // Accepted as a steer just as the run settles: stranded in Pi's queue.
        child.respond(command, { disposition: "queued" });
        child.finishRun("first");
      } else if (command.type === "prompt") {
        child.respond(command, { disposition: "started" });
        child.userMessage(command.message);
        child.finishRun("second");
      } else if (command.type === "clear_queue") {
        child.respond(command, { steering: [sent[1].message], followUp: [] });
      } else defaultHandler(child, command);
    });
    await worker.start();
    await worker.send("first task");
    await worker.send("late correction");
    await count(2);

    assert.equal(prompts().length, 3);
    assert.equal(prompts()[2].message, prompts()[1].message);
    assert.deepEqual(turns.map((turn) => turn.turnId), ["t1", "t2"]);
    assert.ok(child().commands.some((command) => command.type === "clear_queue"));
    await worker.stop();
  });

  it("leaves the worker's own queued messages alone when no directive is outstanding", async () => {
    const { worker, count, child } = startWorker((child, command) => {
      if (command.type === "get_state") return child.respond(command, { sessionId: "s", isStreaming: false, pendingMessageCount: 1 });
      defaultHandler(child, command);
    });
    await worker.start();
    await worker.send("task");
    await count(1);
    assert.equal(child().commands.some((command) => command.type === "clear_queue"), false);
    await worker.stop();
  });

  it("closes the settled turn before a deferred prompt opens the next one", async () => {
    const { worker, turns, count } = startWorker((child, command) => {
      if (command.type !== "prompt") return defaultHandler(child, command);
      if (child.commands.filter((sent) => sent.type === "prompt").length === 1) {
        child.respond(command, { disposition: "started" });
        child.userMessage(command.message);
        return;
      }
      // Arrived during settlement: Pi emits agent_settled, then starts it as a new run.
      child.finishRun("first");
      child.respond(command, { disposition: "started" });
      child.userMessage(command.message);
      child.finishRun("second");
    });
    await worker.start();
    const first = await worker.send("one");
    const second = await worker.send("two");
    await count(2);

    assert.equal(second.outcome, "started");
    assert.deepEqual([first.turnId, second.turnId], ["t1", "t2"]);
    assert.deepEqual(turns.map((turn) => turn.result.messages.at(-1)?.content), [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]);
    await worker.stop();
  });

  it("keeps one command in flight and steers a burst in acceptance order", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const { worker, count, prompts, child } = startWorker((child, command) => {
      if (command.type !== "prompt") return defaultHandler(child, command);
      maxInflight = Math.max(maxInflight, ++inflight);
      setTimeout(() => {
        inflight--;
        holdingHandler(child, command);
      }, 5);
    });
    await worker.start();
    await Promise.all(["a", "b", "c", "d"].map((text) => worker.send(text)));
    child().finishRun();
    await count(1);

    assert.equal(maxInflight, 1);
    assert.deepEqual(prompts().map((prompt) => prompt.message.split("\n")[1]), ["a", "b", "c", "d"]);
    await worker.stop();
  });

  it("never resends an unconfirmed directive", async () => {
    const { worker, count, prompts, child } = startWorker((child, command) => {
      if (command.type !== "prompt") defaultHandler(child, command);
    }, { requestTimeoutMs: 20 });
    await worker.start();
    const receipt = await worker.send("slow to confirm");
    assert.equal(receipt.outcome, "queued");
    // The run went ahead even though the response never came.
    child().userMessage(prompts()[0].message);
    child().finishRun();
    await count(1);
    assert.equal(prompts().length, 1);
    await worker.stop();
  });

  it("holds an active-turn slot only while a turn runs", async () => {
    const scheduler = new SubagentScheduler();
    const { worker, count, child } = startWorker(holdingHandler, { scheduler });
    await worker.start();
    await worker.send("one");
    await worker.send("two");
    child().finishRun();
    await count(1);

    // Every slot is free again once the worker is idle.
    const leases = await Promise.all(Array.from({ length: 4 }, () => scheduler.acquireTurn()));
    leases.forEach((lease) => lease.release());
    await worker.stop();
  });

  it("gives each turn only the stderr written during it", async () => {
    const { worker, turns, count } = startWorker((child, command) => {
      if (command.type !== "prompt") return defaultHandler(child, command);
      child.respond(command, { disposition: "started" });
      child.stderr.emit("data", Buffer.from(`warning from ${command.message.split("\n")[1]}\n`));
      child.finishRun();
    });
    await worker.start();
    await worker.send("one");
    await count(1);
    await worker.send("two");
    await count(2);
    assert.deepEqual(turns.map((turn) => turn.result.stderr), ["warning from one\n", "warning from two\n"]);
    await worker.stop();
  });

  it("reports an exit mid-turn as interrupted and fails later directives", async () => {
    const { worker, turns, count, child } = startWorker(holdingHandler);
    await worker.start();
    await worker.send("start");
    child().close(1);
    await count(1);

    assert.equal(turns[0].status, "interrupted");
    assert.equal(worker.phase, "exited");
    assert.equal((await worker.send("too late")).outcome, "failed");
  });
});
