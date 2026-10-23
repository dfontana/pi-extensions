import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchCodexUsage,
  formatCodexUsage,
  getCodexAccountId,
  parseCodexUsage,
} from "./codex-usage.ts";

describe("improved-footer codex-usage", () => {
  it("parses 5-hour and weekly windows by duration, regardless of response slot", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 21, limit_window_seconds: 604800, reset_at: 2000 },
        secondary_window: { used_percent: 64, limit_window_seconds: 18000, reset_at: 1000 },
      },
    });

    assert.deepEqual(usage, {
      fiveHour: { usedPercent: 64, resetsAt: 1000 },
      weekly: { usedPercent: 21, resetsAt: 2000 },
    });
  });

  it("ignores malformed and unrelated quota windows", () => {
    assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 3600 } } }), undefined);
    assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 120, limit_window_seconds: 18000 } } }), undefined);
    assert.equal(parseCodexUsage(null), undefined);
  });

  it("formats remaining percentages and reset countdowns compactly", () => {
    assert.equal(
      formatCodexUsage({
        fiveHour: { usedPercent: 20, resetsAt: 3600 },
        weekly: { usedPercent: 9, resetsAt: 183600 },
      }, 0),
      "Codex 5h 80% left (1h) · wk 91% left (2d3h)",
    );
  });

  it("extracts the account id from the Codex JWT auth claim", () => {
    const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
    assert.equal(getCodexAccountId(`header.${payload}.signature`), "acct-test");
    assert.equal(getCodexAccountId("not-a-jwt"), undefined);
  });

  it("fetches usage with the account-scoped OAuth request and parses the response", async () => {
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;
    const usage = await fetchCodexUsage("access-token", "acct-test", {
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    assert.equal(requestedUrl, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(requestedHeaders?.get("authorization"), "Bearer access-token");
    assert.equal(requestedHeaders?.get("chatgpt-account-id"), "acct-test");
    assert.deepEqual(usage, { fiveHour: { usedPercent: 25 } });
  });
});
