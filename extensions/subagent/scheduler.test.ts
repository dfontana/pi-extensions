import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubagentScheduler } from "./scheduler.ts";

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
});
