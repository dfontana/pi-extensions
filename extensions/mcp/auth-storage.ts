/**
 * Persistence boundary for MCP OAuth credentials.
 *
 * Records remain keyed by server URL and preserve the existing auth.json shape.
 * Backends may perform I/O asynchronously. `update` transforms one record and
 * must apply that transformation as a single backend operation; returning the
 * current record unchanged is a no-op, and returning `undefined` deletes it.
 */

import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { STATE_DIR, readState, writeState } from "./config.ts";

/** One server's persisted OAuth registration, tokens, and in-progress flow. */
export interface AuthRecord {
  client?: StoredOAuthClientInformation;
  /** Unix-ms timestamp recorded when the DCR response was saved. */
  registeredAt?: number;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  authorizationState?: string;
  discoveryState?: OAuthDiscoveryState;
}

/** Async-capable, per-server OAuth credential storage contract. */
export interface AuthStorage {
  read(serverUrl: string): Promise<AuthRecord | undefined>;
  update(
    serverUrl: string,
    transform: (current: AuthRecord | undefined) => AuthRecord | undefined,
  ): Promise<void>;
}

const AUTH_FILE = "auth.json";
type AuthStore = Record<string, AuthRecord>;

/** Existing plaintext auth.json backend; location and serialized format are unchanged. */
export class FileAuthStorage implements AuthStorage {
  async read(serverUrl: string): Promise<AuthRecord | undefined> {
    return readState<AuthStore>(AUTH_FILE, {})[serverUrl];
  }

  async update(
    serverUrl: string,
    transform: (current: AuthRecord | undefined) => AuthRecord | undefined,
  ): Promise<void> {
    const store = readState<AuthStore>(AUTH_FILE, {});
    const current = store[serverUrl];
    const next = transform(current);
    if (next === current) return;
    if (next === undefined) delete store[serverUrl];
    else store[serverUrl] = next;
    writeState(AUTH_FILE, store);
  }
}

export interface KeychainAdapter {
  getPassword(account: string): Promise<string | undefined>;
  setPassword(account: string, password: string): Promise<void>;
  deletePassword(account: string): Promise<void>;
}

const KEYCHAIN_SERVICE = "pi-extensions";

/** Security.framework via @napi-rs/keyring; loaded lazily so non-macOS never needs the native binding. */
const keychain: KeychainAdapter = {
  async getPassword(account) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return (await new AsyncEntry(KEYCHAIN_SERVICE, account).getPassword()) ?? undefined;
  },
  async setPassword(account, password) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(KEYCHAIN_SERVICE, account).setPassword(password);
  },
  async deletePassword(account) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(KEYCHAIN_SERVICE, account).deleteCredential();
  },
};

// Shared by all instances: different managers must not lose each other's patches.
const accountUpdates = new Map<string, Promise<void>>();

/** macOS Keychain only. Never reads, migrates, or falls back to auth.json. */
export class MacOSKeyring implements AuthStorage {
  constructor(
    private adapter: KeychainAdapter = keychain,
    private platform: string = process.platform,
    private stateDir: string = STATE_DIR,
  ) {}

  private account(serverUrl: string): string {
    if (this.platform !== "darwin") {
      throw new Error("MCP OAuth credential storage requires macOS Keychain. Use macOS for OAuth, or configure bearer authentication or a stdio server; plaintext storage fallback is disabled.");
    }
    const digest = createHash("sha256").update(JSON.stringify([this.stateDir, serverUrl])).digest("hex");
    return `mcp.oauth.${digest}`;
  }

  private async readAccount(account: string): Promise<AuthRecord | undefined> {
    const secret = await this.adapter.getPassword(account);
    if (secret === undefined) return undefined;
    let record: unknown;
    try { record = JSON.parse(secret); }
    catch { throw new Error("Invalid MCP OAuth Keychain record. Clear this credential in Keychain Access and re-authenticate with /mcp (Shift+A)."); }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid MCP OAuth Keychain record. Clear this credential in Keychain Access and re-authenticate with /mcp (Shift+A).");
    }
    return record as AuthRecord;
  }

  async read(serverUrl: string): Promise<AuthRecord | undefined> {
    return this.readAccount(this.account(serverUrl));
  }

  async update(serverUrl: string, transform: (current: AuthRecord | undefined) => AuthRecord | undefined): Promise<void> {
    const account = this.account(serverUrl);
    const previous = accountUpdates.get(account) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.readAccount(account);
      const next = transform(current);
      if (next === current) return;
      if (next === undefined) {
        await this.adapter.deletePassword(account);
        return;
      }
      await this.adapter.setPassword(account, JSON.stringify(next));
    });
    accountUpdates.set(account, operation);
    try { await operation; }
    finally { if (accountUpdates.get(account) === operation) accountUpdates.delete(account); }
  }
}

/** macOS fails closed on Keychain errors; other platforms use the plaintext file adapter. */
export const defaultAuthStorage: AuthStorage = process.platform === "darwin"
  ? new MacOSKeyring()
  : new FileAuthStorage();
