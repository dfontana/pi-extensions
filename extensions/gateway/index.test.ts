import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gateway from "./index.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("gateway", () => {
  it("registers existing providers with the gateway, key command, and provider-over-base headers", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "gateway-plugin-agent-"));
    tempDirs.push(agentDir);
    writeFileSync(
      join(agentDir, "gateway.json"),
      JSON.stringify({
        gateway: "https://private-gateway.example",
        "key-command": "credential-helper token",
        headers: { "x-common": "shared", "x-overridden": "base" },
        providers: [
          {
            provider: "anthropic",
            baseUrl: "$GATEWAY",
            authHeader: "true",
            headers: { provider: "anthropic", "x-overridden": "provider" },
          },
          {
            provider: "openai",
            baseUrl: "$GATEWAY/v1",
            authHeader: "false",
            headers: { provider: "openai" },
          },
        ],
      }),
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const registrations: Array<{ provider: string; config: Record<string, unknown> }> = [];
      const api = {
        registerProvider(provider: string, config: Record<string, unknown>) {
          registrations.push({ provider, config });
        },
      } as unknown as ExtensionAPI;

      gateway(api);

      assert.deepEqual(registrations, [
        {
          provider: "anthropic",
          config: {
            baseUrl: "https://private-gateway.example",
            apiKey: "!credential-helper token",
            authHeader: true,
            headers: {
              "x-common": "shared",
              "x-overridden": "provider",
              provider: "anthropic",
            },
          },
        },
        {
          provider: "openai",
          config: {
            baseUrl: "https://private-gateway.example/v1",
            apiKey: "!credential-helper token",
            authHeader: false,
            headers: {
              "x-common": "shared",
              "x-overridden": "base",
              provider: "openai",
            },
          },
        },
      ]);
      assert.ok(registrations.every(({ config }) => !Object.hasOwn(config, "models")));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("warns and skips registration when the config is invalid", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "gateway-invalid-agent-"));
    tempDirs.push(agentDir);
    writeFileSync(join(agentDir, "gateway.json"), JSON.stringify({ gateway: "" }));

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const registrations: string[] = [];
      const warnings: string[] = [];
      let sessionStart: ((...args: unknown[]) => unknown) | undefined;
      const api = {
        registerProvider(provider: string) {
          registrations.push(provider);
        },
        on(_event: string, handler: (...args: unknown[]) => unknown) {
          sessionStart = handler;
        },
      } as unknown as ExtensionAPI;

      gateway(api);
      sessionStart?.(undefined, { ui: { notify: (message: string) => warnings.push(message) } });

      assert.deepEqual(registrations, []);
      assert.deepEqual(warnings, ["gateway disabled: config: gateway must be a non-empty string"]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
