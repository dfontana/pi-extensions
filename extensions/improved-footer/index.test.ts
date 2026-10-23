import assert from "node:assert/strict";
import { describe, it } from "node:test";
import improvedFooter from "./index.ts";

function makeHarness(
  mode: "tui" | "rpc",
  usesOAuth = true,
  getApiKeyAndHeaders: () => Promise<{ ok: boolean; apiKey?: string }> = async () => ({ ok: true, apiKey: makeAccessToken() }),
) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footerFactory: ((...args: any[]) => any) | undefined;
  let oauthEnabled = usesOAuth;
  let footerSetCount = 0;
  const model = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
  const pi = {
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    getThinkingLevel: () => "off",
  };
  improvedFooter(pi as any);

  const ctx = {
    mode,
    model,
    cwd: "/tmp",
    modelRegistry: {
      isUsingOAuth: () => oauthEnabled,
      getApiKeyAndHeaders,
      getApiKeyForProvider: async () => undefined,
    },
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionName: () => undefined,
      getEntries: () => [],
    },
    getContextUsage: () => undefined,
    ui: {
      setFooter(factory: ((...args: any[]) => any) | undefined) {
        footerSetCount++;
        footerFactory = factory;
      },
    },
  };

  return {
    handlers,
    ctx,
    get footerFactory() { return footerFactory; },
    get footerSetCount() { return footerSetCount; },
    setOAuthEnabled(enabled: boolean) { oauthEnabled = enabled; },
  };
}

function makeAccessToken(): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  return `header.${payload}.signature`;
}

function footerData() {
  return {
    onBranchChange: () => () => {},
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map(),
  };
}

async function waitForUsageLine(component: { render(width: number): string[] }): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lines = component.render(120);
    const usageLine = lines.find((line) => line.includes("Codex 5h"));
    if (usageLine) return usageLine;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("improved-footer", () => {
  it("renders Codex subscription windows for an authenticated Codex model in the TUI", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/wham/usage")) {
        return new Response(JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
            secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 7200 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const harness = makeHarness("tui", false);
    let component: { render(width: number): string[]; dispose(): void } | undefined;
    try {
      await harness.handlers.get("session_start")?.({}, harness.ctx);
      assert.ok(harness.footerFactory);
      const activeComponent: { render(width: number): string[]; dispose(): void } = harness.footerFactory(
        { requestRender() {} },
        { fg: (_color: string, text: string) => text },
        footerData(),
      );
      component = activeComponent;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requestedUrls.some((url) => url.endsWith("/wham/usage")), false);

      harness.setOAuthEnabled(true);
      const codexResponse = {
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      };
      await harness.handlers.get("message_end")?.(codexResponse, harness.ctx);
      const usageLine = await waitForUsageLine(activeComponent);

      assert.match(usageLine, /5h 75% left/);
      assert.match(usageLine, /wk 90% left/);
      assert.equal(requestedUrls.filter((url) => url.endsWith("/wham/usage")).length, 1);

      harness.setOAuthEnabled(false);
      await harness.handlers.get("message_end")?.(codexResponse, harness.ctx);
      assert.equal(activeComponent.render(120).some((line) => line.includes("Codex 5h")), false);
      assert.equal(requestedUrls.filter((url) => url.endsWith("/wham/usage")).length, 1);
    } finally {
      component?.dispose();
      await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
      globalThis.fetch = originalFetch;
    }
  });

  it("does not request usage when OAuth disappears during token lookup", async () => {
    const originalFetch = globalThis.fetch;
    let usageRequestCount = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/wham/usage")) usageRequestCount++;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const authStarted = deferred<void>();
    const pendingAuth = deferred<{ ok: boolean; apiKey?: string }>();
    const harness = makeHarness("tui", true, async () => {
      authStarted.resolve(undefined);
      return pendingAuth.promise;
    });
    let component: { render(width: number): string[]; dispose(): void } | undefined;
    try {
      await harness.handlers.get("session_start")?.({}, harness.ctx);
      assert.ok(harness.footerFactory);
      const activeComponent: { render(width: number): string[]; dispose(): void } = harness.footerFactory(
        { requestRender() {} },
        { fg: (_color: string, text: string) => text },
        footerData(),
      );
      component = activeComponent;
      await authStarted.promise;

      harness.setOAuthEnabled(false);
      pendingAuth.resolve({ ok: true, apiKey: makeAccessToken() });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(usageRequestCount, 0);
      assert.equal(activeComponent.render(120).some((line) => line.includes("Codex 5h")), false);
    } finally {
      component?.dispose();
      await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
      globalThis.fetch = originalFetch;
    }
  });

  it("does not display usage returned after OAuth disappears during fetch", async () => {
    const originalFetch = globalThis.fetch;
    let usageRequestCount = 0;
    const requestStarted = deferred<void>();
    const pendingResponse = deferred<Response>();
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/wham/usage")) {
        usageRequestCount++;
        requestStarted.resolve(undefined);
        return pendingResponse.promise;
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const harness = makeHarness("tui");
    let component: { render(width: number): string[]; dispose(): void } | undefined;
    try {
      await harness.handlers.get("session_start")?.({}, harness.ctx);
      assert.ok(harness.footerFactory);
      const activeComponent: { render(width: number): string[]; dispose(): void } = harness.footerFactory(
        { requestRender() {} },
        { fg: (_color: string, text: string) => text },
        footerData(),
      );
      component = activeComponent;
      await requestStarted.promise;

      harness.setOAuthEnabled(false);
      pendingResponse.resolve(new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(usageRequestCount, 1);
      assert.equal(activeComponent.render(120).some((line) => line.includes("Codex 5h")), false);
    } finally {
      component?.dispose();
      await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
      globalThis.fetch = originalFetch;
    }
  });

  it("does not install the footer or query Codex usage in headless mode", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const harness = makeHarness("rpc");
    try {
      await harness.handlers.get("session_start")?.({}, harness.ctx);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(harness.footerSetCount, 0);
      assert.equal(requestedUrls.some((url) => url.endsWith("/wham/usage")), false);
    } finally {
      await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
      globalThis.fetch = originalFetch;
    }
  });
});
