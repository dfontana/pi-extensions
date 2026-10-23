import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ACTIVE_CHILDREN, SubagentScheduler } from "./scheduler.ts";

describe("subagent scheduler", () => {
  it("keeps setup admission FIFO while callers acquire after setup", async () => {
    const scheduler = new SubagentScheduler();
    const first = scheduler.admit();
    const second = scheduler.admit();
    const secondAcquire = second.acquire();
    const waiting = await Promise.race([
      secondAcquire.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(waiting, false, "second cannot overtake an earlier admitted setup");

    const firstLease = await first.acquire();
    firstLease?.release();
    first.close();
    const secondLease = await secondAcquire;
    assert.ok(secondLease);
    secondLease.release();
    second.close();
  });

  it("shares the active-turn limit between calls and vibe turns", async () => {
    const scheduler = new SubagentScheduler();
    const turns = await Promise.all(Array.from({ length: MAX_ACTIVE_CHILDREN }, () => scheduler.acquireTurn()));
    const call = scheduler.admit();
    let granted = false;
    const lease = call.acquire().then((value) => { granted = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(granted, false);

    turns[0].release();
    assert.ok(await lease);
    call.close();
  });
});
