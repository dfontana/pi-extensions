/**
 * Config + persistent state for the mcp extension.
 *
 * Servers are read (never written) from standard `.mcp.json` files, merged in
 * precedence order (project wins over global). We honor the standard
 * `mcpServers.{name}.{command,args,env}` shape and add a small, clearly-marked
 * set of non-standard fields for HTTP/OAuth (`url`, `headers`, `auth`, `oauth`,
 * `bearerToken*`). The extension's own mutable state (OAuth creds, metadata
 * cache) lives under `~/.pi/agent/mcp/` and is read/written there.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AuthMode = "none" | "bearer" | "oauth";

export interface ServerDef {
  name: string;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http
  url?: string;
  headers?: Record<string, string>;
  // auth (non-standard; resolved here, never written back to .mcp.json)
  auth: AuthMode;
  bearerToken?: string;
  oauth?: {
    redirectUri?: string;
    grantType?: "authorization_code" | "client_credentials";
    scope?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

const HOME = homedir();
// Honors the PI_CODING_AGENT_DIR override (same resolution as pi itself).
export const STATE_DIR = join(getAgentDir(), "mcp");
let stateWriteSequence = 0;

// ---- env / path interpolation ----------------------------------------------

/**
 * Expand `${VAR}` and `$env:VAR` against process.env (unknown → ""). Bare `$VAR`
 * is intentionally not expanded so literal `$` in tokens/passwords is preserved.
 */
function expand(value: string): string {
  return value
    .replace(/\$env:([A-Za-z_]\w*)/g, (_, n) => process.env[n] ?? "")
    .replace(/\$\{([A-Za-z_]\w*)\}/g, (_, n) => process.env[n] ?? "");
}

function expandMap(m: unknown): Record<string, string> | undefined {
  if (!m || typeof m !== "object") return undefined;
  return Object.fromEntries(Object.entries(m as Record<string, unknown>).map(([k, v]) => [k, expand(String(v))]));
}

function expandPath(p: string): string {
  return expand(p.startsWith("~") ? HOME + p.slice(1) : p);
}

// ---- config loading (read-only) --------------------------------------------

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function normalize(name: string, raw: Record<string, unknown>): ServerDef {
  const def: ServerDef = { name, auth: "none" };
  if (typeof raw.command === "string") def.command = raw.command;
  if (Array.isArray(raw.args)) def.args = raw.args.map(String);
  def.env = expandMap(raw.env);
  if (typeof raw.cwd === "string") def.cwd = expandPath(raw.cwd);
  if (typeof raw.url === "string") def.url = raw.url;
  def.headers = expandMap(raw.headers);
  if (typeof raw.bearerToken === "string") def.bearerToken = expand(raw.bearerToken);
  if (typeof raw.bearerTokenEnv === "string") def.bearerToken = process.env[raw.bearerTokenEnv] ?? "";
  if (raw.oauth && typeof raw.oauth === "object") def.oauth = { ...(raw.oauth as object) };

  // Resolve auth mode: explicit wins, else infer (bearer token → bearer,
  // bare http url → oauth so a 401 can trigger the flow, otherwise none).
  const explicit = raw.auth;
  def.auth =
    explicit === "bearer" || explicit === "oauth" || explicit === "none"
      ? explicit
      : def.bearerToken
        ? "bearer"
        : def.url
          ? "oauth"
          : "none";
  return def;
}

/** Merge `~/.pi/agent/mcp.json` (global) then `./.mcp.json` (project overrides global). */
export function loadServers(cwd: string): Map<string, ServerDef> {
  const merged = new Map<string, ServerDef>();
  for (const path of [join(getAgentDir(), "mcp.json"), resolve(cwd, ".mcp.json")]) {
    const servers = readJson(path)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, raw] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
      merged.set(name, normalize(name, raw));
    }
  }
  return merged;
}

export function transportKind(def: ServerDef): "stdio" | "http" | "invalid" {
  return def.command ? "stdio" : def.url ? "http" : "invalid";
}

/** Stable identity over the fields that define a server's tool surface. */
export function identity(def: ServerDef): string {
  const id = JSON.stringify([def.command, def.args, def.env, def.cwd, def.url, def.headers, def.auth]);
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

// ---- mutable state under ~/.pi/agent/mcp/ ----------------------------------

export function readState<T>(file: string, fallback: T): T {
  return (readJson(join(STATE_DIR, file)) as T) ?? fallback;
}

export function writeState(file: string, data: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, file);
  const temporary = join(STATE_DIR, `.${file}.${process.pid}.${Date.now()}.${stateWriteSequence++}.tmp`);
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  renameSync(temporary, path);
}
