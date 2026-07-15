import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, SubagentConfig } from "./contracts.ts";
import { DEFAULT_CONFIG } from "./contracts.ts";
import { isChildDiscoverable, resolveRoute, resolveTools } from "./resolution.ts";

const definition: AgentDefinition = {
  id: "test", displayName: "Test", description: "test", systemPrompt: "test", source: "builtin",
};

function model(provider: string, id: string, reasoning = true) {
  return {
    provider, id, name: id, api: "test", baseUrl: "https://example.invalid", reasoning,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 100, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  } as any;
}

function context(models: any[], auth: { ok: boolean; error?: string } = { ok: true }): ExtensionContext {
  return {
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      getApiKeyAndHeaders: async () => auth,
    },
  } as unknown as ExtensionContext;
}

describe("process-subagents resolution", () => {
  test("resolves aliases and persists the exact route", async () => {
    const target = model("provider", "model-id");
    const config: SubagentConfig = { ...DEFAULT_CONFIG, modelAliases: { fast: "provider/model-id" } };
    const route = await resolveRoute(context([target]), config, definition, "fast", "high", "medium");
    assert.equal(route.model, target);
    assert.deepEqual(route.modelRequest, { reference: "fast", source: "call" });
    assert.equal(route.thinking, "high");
  });

  test("does not apply aliases to an implicit persisted resume route", async () => {
    const previous = {
      resolvedModel: { provider: "old", id: "model" }, thinking: "off",
    } as any;
    const old = model("old", "model", false);
    const redirected = model("new", "model", false);
    const config: SubagentConfig = { ...DEFAULT_CONFIG, modelAliases: { "old/model": "new/model" } };
    const route = await resolveRoute(context([old, redirected]), config, definition, undefined, undefined, "off", previous);
    assert.equal(route.model.provider, "old");
  });

  test("requires unique exact bare model IDs", async () => {
    await assert.rejects(
      resolveRoute(context([model("a", "same"), model("b", "same")]), DEFAULT_CONFIG, definition, "same", "high", "high"),
      /ambiguous.*a\/same, b\/same/,
    );
  });

  test("fails authentication and unsupported thinking without clamping", async () => {
    await assert.rejects(
      resolveRoute(context([model("p", "m")], { ok: false, error: "login required" }), DEFAULT_CONFIG, definition, "p/m", "high", "high"),
      /Authentication.*login required/,
    );
    await assert.rejects(
      resolveRoute(context([model("p", "plain", false)]), DEFAULT_CONFIG, definition, "p/plain", "high", "high"),
      /not supported.*off/,
    );
  });

  test("allows only active child-discoverable tools and filters delegation", () => {
    const builtin = (name: string): ToolInfo => ({ name, description: "", parameters: {} as any, sourceInfo: {
      path: `<builtin:${name}>`, source: "builtin", scope: "user", origin: "top-level",
    } });
    const extension: ToolInfo = { ...builtin("web"), sourceInfo: {
      path: "/x/web.ts", source: "web-access", scope: "project", origin: "package",
    } };
    const sdk: ToolInfo = { ...builtin("sdk_tool"), sourceInfo: {
      path: "<sdk:sdk_tool>", source: "sdk", scope: "temporary", origin: "top-level",
    } };
    const tools = [builtin("read"), builtin("Agent"), extension, sdk];
    assert.equal(isChildDiscoverable(extension), true);
    assert.equal(isChildDiscoverable(sdk), false);
    assert.deepEqual(resolveTools(["read", "Agent", "web", "sdk_tool"], tools, definition), ["read", "web"]);
    assert.throws(() => resolveTools(["sdk_tool"], tools, { ...definition, tools: ["sdk_tool"] }), /parent-only/);
  });

  test("applies Research mutation exclusions only to the bundled definition", () => {
    const tool = (name: string): ToolInfo => ({ name, description: "", parameters: {} as any, sourceInfo: {
      path: `<builtin:${name}>`, source: "builtin", scope: "user", origin: "top-level",
    } });
    const active = ["read", "edit", "write"];
    const tools = active.map(tool);
    assert.deepEqual(resolveTools(active, tools, { ...definition, id: "Research", source: "builtin" }), ["read"]);
    assert.deepEqual(resolveTools(active, tools, { ...definition, id: "Research", source: "project" }), ["edit", "read", "write"]);
  });
});
