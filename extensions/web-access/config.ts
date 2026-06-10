/**
 * Config loader for the web-access extension.
 *
 * Reads and merges two optional config files, synchronously:
 *   - Global:  ~/.pi/agent/web-access.json
 *   - Project: <cwd>/.pi/web-access.json   (overrides global)
 *
 * The project file is merged over the global one: top-level scalars override,
 * and `providerParams` is deep-merged per provider key.
 *
 * Config schema
 * ─────────────
 * {
 *   "provider": "openai",            // required — provider id in the model registry
 *   "model": "gpt-5.5",              // required — model id within that provider
 *   "providerParams": {               // optional — extra web-search params, keyed by
 *     "openai":     { "search_context_size": "medium" },   //   provider, in the shape
 *     "openrouter": { "engine": "exa", "max_results": 10 } //   the provider's tool expects
 *   }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WebAccessConfig {
  provider: string;
  model: string;
  providerParams: Record<string, Record<string, unknown>>;
}

export type LoadResult = { ok: true; config: WebAccessConfig } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Deep-merge `over` onto `base`, special-casing `providerParams` per provider key. */
function mergeRaw(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, ...over };
  if (isRecord(base.providerParams) || isRecord(over.providerParams)) {
    const bp = isRecord(base.providerParams) ? base.providerParams : {};
    const op = isRecord(over.providerParams) ? over.providerParams : {};
    const merged: Record<string, unknown> = { ...bp };
    for (const [k, v] of Object.entries(op)) {
      merged[k] = isRecord(merged[k]) && isRecord(v) ? { ...(merged[k] as object), ...v } : v;
    }
    out.providerParams = merged;
  }
  return out;
}

function validateConfig(raw: Record<string, unknown>): LoadResult {
  if (typeof raw.provider !== "string" || raw.provider.trim() === "") {
    return { ok: false, error: "config: 'provider' must be a non-empty string" };
  }
  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    return { ok: false, error: "config: 'model' must be a non-empty string" };
  }

  const providerParams: Record<string, Record<string, unknown>> = {};
  if (raw.providerParams !== undefined) {
    if (!isRecord(raw.providerParams)) {
      return { ok: false, error: "config: 'providerParams' must be an object keyed by provider" };
    }
    for (const [k, v] of Object.entries(raw.providerParams)) {
      if (!isRecord(v)) return { ok: false, error: `config: providerParams.${k} must be an object` };
      providerParams[k] = v;
    }
  }

  return {
    ok: true,
    config: {
      provider: raw.provider,
      model: raw.model,
      providerParams,
    },
  };
}

/** Load, merge, and validate web-access.json (global then project override). */
export function loadConfig(cwd: string): LoadResult {
  const globalPath = join(getAgentDir(), "web-access.json");
  const localPath = join(cwd, ".pi", "web-access.json");

  let merged: Record<string, unknown> = {};
  let found = false;

  for (const path of [globalPath, localPath]) {
    if (!existsSync(path)) continue;
    const res = readJson(path);
    if (!res.ok) return { ok: false, error: res.error };
    if (!isRecord(res.value)) return { ok: false, error: `${path} must be a JSON object` };
    found = true;
    merged = mergeRaw(merged, res.value);
  }

  if (!found) {
    return { ok: false, error: `no web-access.json found (looked in ${globalPath} and ${localPath})` };
  }

  return validateConfig(merged);
}
