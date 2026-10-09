import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KeychainAdapter, AuthRecord } from "./auth-storage.ts";

const dir = mkdtempSync(join(tmpdir(), "mcp-keyring-"));
process.env.PI_CODING_AGENT_DIR = dir;
// Exercise the production file fallback even on macOS CI, without real Keychain access.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
const { MacOSKeyring, FileAuthStorage, defaultAuthStorage } = await import("./auth-storage.ts");
const { oauthProvider, clearOAuthCredentials } = await import("./auth.ts");
const { Manager } = await import("./manager.ts");
Object.defineProperty(process, "platform", platformDescriptor);
after(() => rmSync(dir, { recursive: true, force: true }));

class MockKeychain implements KeychainAdapter {
  records = new Map<string, string>();
  writes = 0;
  deletes = 0;
  async getPassword(account: string) { await Promise.resolve(); return this.records.get(account); }
  async setPassword(account: string, password: string) { this.writes++; this.records.set(account, password); }
  async deletePassword(account: string) { this.deletes++; this.records.delete(account); }
}

describe("mcp auth-storage", () => {
  it("roundtrips JSON records, preserves patches, deletes, and isolates exact URLs and agent directories", async () => {
    const adapter = new MockKeychain();
    const storage = new MacOSKeyring(adapter, "darwin", "/agent-one/mcp");
    const other = new MacOSKeyring(adapter, "darwin", "/agent-two/mcp");
    const url = "https://example.test/mcp";
    const record: AuthRecord = { client: { client_id: "id", client_secret: "secret" }, tokens: { access_token: "access", token_type: "bearer" }, codeVerifier: "verifier" };
    assert.equal(await storage.read(url), undefined);
    await storage.update(url, () => record);
    assert.deepEqual(await storage.read(url), record);
    assert.equal(await other.read(url), undefined);
    assert.equal(await storage.read(url + "/"), undefined);
    assert.equal(await storage.read(url.toUpperCase()), undefined);
    await other.update(url, () => ({ codeVerifier: "other" }));
    await storage.update(url + "/", () => ({ codeVerifier: "slash" }));
    assert.equal(adapter.records.size, 3);
    for (const account of adapter.records.keys()) assert.match(account, /^mcp\.oauth\.[a-f0-9]{64}$/);
    await storage.update(url, (current) => ({ ...current, registeredAt: 123 }));
    assert.deepEqual(await storage.read(url), { ...record, registeredAt: 123 });
    const writes = adapter.writes;
    await storage.update(url, (current) => current);
    assert.equal(adapter.writes, writes);
    await storage.update(url, () => undefined);
    assert.equal(await storage.read(url), undefined);
    assert.equal(adapter.deletes, 1);
    assert.deepEqual(await other.read(url), { codeVerifier: "other" });
  });

  it("serializes same-account updates process-wide across storage instances", async () => {
    const adapter = new MockKeychain();
    const first = new MacOSKeyring(adapter, "darwin", dir);
    const second = new MacOSKeyring(adapter, "darwin", dir);
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).update("url", (record) => ({ registeredAt: (record?.registeredAt ?? 0) + 1 }))));
    assert.equal((await first.read("url"))?.registeredAt, 30);
  });

  it("rejects malformed and nonobject credentials without exposing their contents", async () => {
    for (const secret of ['{"secret":"TOP-SECRET",', 'null', '[]', '"TOP-SECRET"', '42']) {
      const adapter: KeychainAdapter = { getPassword: async () => secret, setPassword: async () => assert.fail("must not overwrite corruption"), deletePassword: async () => assert.fail("must not delete corruption") };
      const storage = new MacOSKeyring(adapter, "darwin", dir);
      for (const operation of [() => storage.read("url"), () => storage.update("url", () => ({}))]) {
        await assert.rejects(operation, (error: Error) => {
          assert.match(error.message, /Invalid MCP OAuth Keychain record/);
          assert.doesNotMatch(error.message, /TOP-SECRET/);
          return true;
        });
      }
    }
  });

  it("propagates adapter failures and releases serialization after a rejected update", async () => {
    for (const method of ["getPassword", "setPassword", "deletePassword"] as const) {
      const adapter = new MockKeychain();
      const storage = new MacOSKeyring(adapter, "darwin", dir);
      await storage.update("url", () => ({ codeVerifier: "saved" }));
      const original = adapter[method].bind(adapter);
      const failure = new Error("Keychain unavailable");
      adapter[method] = async () => { throw failure; };
      await assert.rejects(() => storage.update("url", () => method === "deletePassword" ? undefined : {}), (error) => error === failure);
      if (method === "getPassword") await assert.rejects(() => storage.read("url"), (error) => error === failure);
      // Restore the mock boundary and verify no poisoned queue remains.
      Object.assign(adapter, { [method]: original });
      await storage.update("url", () => ({ codeVerifier: "recovered" }));
      assert.equal((await storage.read("url"))?.codeVerifier, "recovered");
    }
  });

  it("fails closed for oversized serialized commands, including quote escaping and UTF-8", async () => {
    const adapter = new MockKeychain();
    const storage = new MacOSKeyring(adapter, "darwin", dir);
    for (const codeVerifier of ["x".repeat(4096), '"'.repeat(1500), "😀".repeat(1000)]) {
      await assert.rejects(() => storage.update("url", () => ({ codeVerifier })), /4096-byte stdin limit/);
    }
    assert.equal(adapter.writes, 0);
    assert.equal(await storage.read("url"), undefined);
  });

  it("rejects nonmacOS credential operations without helper calls or plaintext fallback/migration", async () => {
    const path = join(dir, "mcp", "auth.json");
    mkdirSync(join(dir, "mcp"), { recursive: true });
    const plaintext = '{"url":{"codeVerifier":"legacy-secret"}}';
    writeFileSync(path, plaintext);
    const adapter: KeychainAdapter = {
      getPassword: async () => assert.fail("must not use Keychain"),
      setPassword: async () => assert.fail("must not use Keychain"),
      deletePassword: async () => assert.fail("must not use Keychain"),
    };
    for (const platform of ["linux", "win32", "freebsd"]) {
      const storage = new MacOSKeyring(adapter, platform, dir);
      await assert.rejects(() => storage.read("url"), /requires macOS Keychain/);
      await assert.rejects(() => storage.update("url", () => undefined), /requires macOS Keychain/);
    }
    const mac = new MacOSKeyring(new MockKeychain(), "darwin", dir);
    assert.equal(await mac.read("url"), undefined, "legacy plaintext is never migrated");
    await mac.update("url", () => ({ codeVerifier: "new-secret" }));
    assert.equal(readFileSync(path, "utf8"), plaintext, "legacy file is never changed or deleted");
  });

  it("uses file storage by default off macOS, including provider saves and clearing", async () => {
    const manager = new Manager();
    assert.equal(manager.authStorage, defaultAuthStorage);
    assert.ok(defaultAuthStorage instanceof FileAuthStorage);
    const def = { name: "file-default", url: "https://file-default.example.test", auth: "oauth" as const };
    const provider = await oauthProvider(def);
    await provider.saveTokens({ access_token: "file-token", token_type: "bearer" });
    const path = join(dir, "mcp", "auth.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[def.url].tokens.access_token, "file-token");
    assert.equal((await provider.tokens())?.access_token, "file-token");
    await clearOAuthCredentials(def);
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[def.url], undefined);
  });
});
