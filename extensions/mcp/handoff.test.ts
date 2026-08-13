import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consumeEnabledSnapshot,
  MCP_ENABLED_SNAPSHOT_ENV,
  serializeEnabledSnapshot,
} from "./handoff.ts";
import type { McpEnabledSnapshot } from "./manager.ts";

const snapshot: McpEnabledSnapshot = {
  version: 1,
  servers: [{ name: "docs", identity: "0123456789abcdef" }],
};

describe("mcp handoff", () => {
  it("round-trips a snapshot and consumes its environment value", () => {
    const serialized = serializeEnabledSnapshot(snapshot);
    assert.ok(serialized);
    const environment: Record<string, string | undefined> = {
      [MCP_ENABLED_SNAPSHOT_ENV]: serialized,
    };

    const consumed = consumeEnabledSnapshot(environment);

    assert.deepEqual(consumed, snapshot);
    assert.equal(environment[MCP_ENABLED_SNAPSHOT_ENV], undefined);
    assert.notEqual(consumed, snapshot);
    assert.notEqual(consumed?.servers, snapshot.servers);
  });

  it("fails closed and still removes malformed values", () => {
    const malformed = [
      "not json",
      JSON.stringify({ version: 2, servers: [] }),
      JSON.stringify({ version: 1, servers: [{ name: "docs" }] }),
    ];

    for (const serialized of malformed) {
      const environment: Record<string, string | undefined> = {
        [MCP_ENABLED_SNAPSHOT_ENV]: serialized,
      };
      assert.equal(consumeEnabledSnapshot(environment), undefined);
      assert.equal(environment[MCP_ENABLED_SNAPSHOT_ENV], undefined);
    }
  });

  it("rejects values beyond the handoff size limit", () => {
    const oversized: McpEnabledSnapshot = {
      version: 1,
      servers: [{ name: "x".repeat(300_000), identity: "id" }],
    };
    assert.equal(serializeEnabledSnapshot(oversized), undefined);
  });
});
