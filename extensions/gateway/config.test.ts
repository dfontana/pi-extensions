import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-agent-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, content: unknown): void {
  writeFileSync(join(dir, CONFIG_FILE), typeof content === "string" ? content : JSON.stringify(content));
}

const sampleConfig = {
  gateway: "https://gateway.example",
  "key-command": "credential-helper token",
  headers: { "x-shared": "base", "x-overridden": "base" },
  providers: [
    {
      provider: "anthropic",
      baseUrl: "$GATEWAY",
      authHeader: "true",
      headers: { provider: "anthropic", "x-overridden": "anthropic" },
    },
    {
      provider: "openai",
      baseUrl: "$GATEWAY/v1",
      authHeader: "false",
      headers: { provider: "openai" },
    },
  ],
};

describe("gateway config", () => {
  it("treats a missing global config as disabled without an error", () => {
    assert.deepEqual(loadConfig(agentDir()), { ok: true, config: undefined });
  });

  it("loads provider settings, expands $GATEWAY, and normalizes authHeader", () => {
    const dir = agentDir();
    writeConfig(dir, sampleConfig);

    assert.deepEqual(loadConfig(dir), {
      ok: true,
      config: {
        gateway: "https://gateway.example",
        keyCommand: "credential-helper token",
        headers: { "x-shared": "base", "x-overridden": "base" },
        providers: [
          {
            provider: "anthropic",
            baseUrl: "https://gateway.example",
            authHeader: true,
            headers: { provider: "anthropic", "x-overridden": "anthropic" },
          },
          {
            provider: "openai",
            baseUrl: "https://gateway.example/v1",
            authHeader: false,
            headers: { provider: "openai" },
          },
        ],
      },
    });
  });

  it("reports malformed JSON and invalid provider entries", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["malformed JSON", "{not-json", /failed to read .*gateway\.json/],
      ["missing key command", { ...sampleConfig, "key-command": " " }, /key-command.*non-empty string/],
      ["invalid headers", { ...sampleConfig, headers: { bad: 42 } }, /headers\.bad must be a string/],
      ["invalid authHeader", { ...sampleConfig, providers: [{ ...sampleConfig.providers[0], authHeader: "yes" }] }, /authHeader must be true or false/],
      ["duplicate providers", { ...sampleConfig, providers: [sampleConfig.providers[0], sampleConfig.providers[0]] }, /duplicate provider/],
    ];

    for (const [label, raw, expectedError] of cases) {
      const dir = agentDir();
      writeConfig(dir, raw);
      const result = loadConfig(dir);
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.match(result.error, expectedError, label);
    }
  });
});
