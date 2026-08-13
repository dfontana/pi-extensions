/**
 * Config loader for the web-access extension.
 *
 * Reads and merges two optional config files, synchronously:
 *   - Global:  ~/.pi/agent/web-access.json
 *   - Project: <cwd>/<CONFIG_DIR_NAME>/web-access.json   (overrides global)
 *
 * The project file is merged over the global one: scalars override; the
 * `search`/`fetch` sections merge key-by-key, with `providerParams` maps
 * merged per provider key.
 *
 * Each tool (web_search, web_fetch) is configured by its own section with the
 * same shape: required `provider`/`model`, then the parameters the providers
 * share in common (flat), then `providerParams` keyed by provider for the
 * parameters they don't. Only the active provider's block is applied, so users
 * can keep params for several providers on hand and switch `provider` freely
 * without reconfiguring (and the wrong provider's params are never sent).
 *
 * Search supports custom OpenAI-compatible provider IDs registered in pi:
 * unknown IDs use the ordinary OpenAI Responses request shape. The named
 * `openrouter` and `openai-codex` IDs select their respective special adapters.
 * Fetch supports custom Anthropic-compatible provider IDs registered in pi:
 * unknown IDs use the ordinary Anthropic Messages request shape. `openrouter`
 * selects its specialized adapter.
 *
 * Config schema
 * ─────────────
 * {
 *   "search": {                          // web_search (omit to disable)
 *     "provider": "openai",              // required — provider id in the model registry
 *     "model": "gpt-5.5",                // required — model id within that provider
 *     // Common params, honored by every provider:
 *     "searchContextSize": "medium",     // "low" | "medium" | "high" (provider default when unset)
 *     "allowedDomains": ["example.com"], // no default
 *     "providerParams": {                 // optional — provider-native extras
 *       "openai":     { "user_location": { "type": "approximate" } },
 *       "openrouter": { "engine": "exa", "max_results": 10 }
 *     }
 *   },
 *   "fetch": {                           // web_fetch (omit to disable)
 *     "provider": "anthropic",           // required
 *     "model": "claude-opus-4-8",        // required
 *     // Common params, honored by every provider. Defaults shown:
 *     "maxUses": 5,
 *     "maxContentTokens": 100000,
 *     "allowedDomains": ["example.com"],     // no default
 *     "blockedDomains": ["private.example.com"], // no default
 *     "providerParams": {                 // optional — provider passthroughs
 *       "anthropic":  { "citations": true, "dynamicFiltering": false },
 *       "openrouter": { "engine": "openrouter" }  // "openrouter" | "exa" (never "auto")
 *     }
 *   }
 * }
 *
 * At least one section must be present.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isRecord,
  OPENROUTER_FETCH_ENGINES,
  type OpenRouterFetchEngine,
  type WebFetchConfig,
} from "./web-fetch.ts";

export const SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
export type SearchContextSize = (typeof SEARCH_CONTEXT_SIZES)[number];

/** Search params shared by every provider (both expose search_context_size). */
export interface WebSearchCommonConfig {
  searchContextSize?: SearchContextSize;
  allowedDomains?: string[];
}

export interface SearchToolConfig {
  provider: string;
  model: string;
  /** Common params — defaults for the agent's per-call arguments. */
  params: WebSearchCommonConfig;
  /** The active provider's native params, spread into the tool object as-is. */
  providerParams: Record<string, unknown>;
}

export interface FetchToolConfig {
  provider: string;
  model: string;
  /** Neutral core (with defaults applied) + the active provider's passthroughs. */
  params: WebFetchConfig;
}

/** A tool is configured iff its section is present; at least one always is. */
export interface WebAccessConfig {
  search?: SearchToolConfig;
  fetch?: FetchToolConfig;
}

/** Applied under user config so only provider/model are required per tool. */
export const DEFAULT_FETCH_PARAMS = {
  maxUses: 5,
  maxContentTokens: 100_000,
} as const satisfies WebFetchConfig;

export type LoadResult = { ok: true; config: WebAccessConfig } | { ok: false; error: string };

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Merge two provider-keyed param maps, merging each provider's object. */
function mergePerProvider(base: unknown, over: unknown): Record<string, unknown> {
  const bp = isRecord(base) ? base : {};
  const op = isRecord(over) ? over : {};
  const merged: Record<string, unknown> = { ...bp };
  for (const [k, v] of Object.entries(op)) {
    merged[k] = isRecord(merged[k]) && isRecord(v) ? { ...(merged[k] as object), ...v } : v;
  }
  return merged;
}

/** Merge a tool section key-by-key, with `providerParams` merged per provider. */
function mergeToolSection(base: unknown, over: unknown): Record<string, unknown> {
  const bs = isRecord(base) ? base : {};
  const os = isRecord(over) ? over : {};
  const merged: Record<string, unknown> = { ...bs, ...os };
  if (isRecord(bs.providerParams) || isRecord(os.providerParams)) {
    merged.providerParams = mergePerProvider(bs.providerParams, os.providerParams);
  }
  return merged;
}

/** Deep-merge `over` onto `base` following the schema above. */
function mergeRaw(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, ...over };
  for (const key of ["search", "fetch"] as const) {
    if (isRecord(base[key]) || isRecord(over[key])) {
      out[key] = mergeToolSection(base[key], over[key]);
    }
  }
  return out;
}

function validateProviderModel(
  raw: Record<string, unknown>,
  where: string,
  supported?: readonly string[],
): { ok: true; provider: string; model: string } | { ok: false; error: string } {
  for (const key of ["provider", "model"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).trim() === "") {
      return { ok: false, error: `config: ${where}.${key} must be a non-empty string` };
    }
  }
  const provider = raw.provider as string;
  if (supported && !supported.includes(provider)) {
    // A misconfigured provider used to slip through to a runtime 403 (e.g. the
    // ChatGPT OAuth backend has no fetch endpoint at all) — fail at load instead.
    const hint =
      where === "fetch" && provider === "openai-codex"
        ? " — the ChatGPT/Codex OAuth backend has no web-fetch capability"
        : "";
    return {
      ok: false,
      error: `config: ${where}.provider "${provider}" is not supported${hint} (supported: ${supported.join(", ")})`,
    };
  }
  return { ok: true, provider, model: raw.model as string };
}

function validateProviderParams(
  raw: unknown,
  where: string,
): { ok: true; value: Record<string, Record<string, unknown>> } | { ok: false; error: string } {
  const out: Record<string, Record<string, unknown>> = {};
  if (raw === undefined) return { ok: true, value: out };
  if (!isRecord(raw)) {
    return { ok: false, error: `config: ${where} must be an object keyed by provider` };
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!isRecord(v)) return { ok: false, error: `config: ${where}.${k} must be an object` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

function validateStringArray(
  v: unknown,
  where: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(v) || v.some((d) => typeof d !== "string")) {
    return { ok: false, error: `config: ${where} must be an array of strings` };
  }
  return { ok: true, value: v as string[] };
}

/** Validate the common (provider-agnostic) search params. */
function validateSearchCommon(
  raw: Record<string, unknown>,
): { ok: true; value: WebSearchCommonConfig } | { ok: false; error: string } {
  const out: WebSearchCommonConfig = {};
  if (raw.searchContextSize !== undefined) {
    if (
      typeof raw.searchContextSize !== "string" ||
      !(SEARCH_CONTEXT_SIZES as readonly string[]).includes(raw.searchContextSize)
    ) {
      return {
        ok: false,
        error: `config: search.searchContextSize must be one of ${SEARCH_CONTEXT_SIZES.join(", ")}`,
      };
    }
    out.searchContextSize = raw.searchContextSize as SearchContextSize;
  }
  if (raw.allowedDomains !== undefined) {
    const domains = validateStringArray(raw.allowedDomains, "search.allowedDomains");
    if (!domains.ok) return domains;
    out.allowedDomains = domains.value;
  }
  return { ok: true, value: out };
}

/** Validate the common (provider-agnostic) fetch params. */
function validateFetchCore(
  raw: Record<string, unknown>,
): { ok: true; value: WebFetchConfig } | { ok: false; error: string } {
  const out: WebFetchConfig = {};
  for (const key of ["maxUses", "maxContentTokens"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, error: `config: fetch.${key} must be a positive integer` };
    }
    out[key] = v;
  }
  for (const key of ["allowedDomains", "blockedDomains"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    const domains = validateStringArray(v, `fetch.${key}`);
    if (!domains.ok) return domains;
    out[key] = domains.value;
  }
  return { ok: true, value: out };
}

/**
 * Validate the known providers' fetch passthroughs. Unknown provider keys are
 * tolerated (and unused); unknown fields within known blocks are ignored.
 */
function validateFetchProviderParams(
  params: Record<string, Record<string, unknown>>,
): { ok: true; value: Record<string, WebFetchConfig> } | { ok: false; error: string } {
  const out: Record<string, WebFetchConfig> = {};

  const anthropic = params.anthropic;
  if (anthropic) {
    const block: WebFetchConfig = {};
    for (const key of ["citations", "dynamicFiltering"] as const) {
      const v = anthropic[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") {
        return { ok: false, error: `config: fetch.providerParams.anthropic.${key} must be a boolean` };
      }
      block[key] = v;
    }
    out.anthropic = block;
  }

  const openrouter = params.openrouter;
  if (openrouter?.engine !== undefined) {
    // "auto"/"native" are rejected on purpose: auto is non-deterministic and
    // native ignores maxContentTokens, breaking parity with Anthropic.
    if (
      typeof openrouter.engine !== "string" ||
      !(OPENROUTER_FETCH_ENGINES as readonly string[]).includes(openrouter.engine)
    ) {
      return {
        ok: false,
        error: `config: fetch.providerParams.openrouter.engine must be one of ${OPENROUTER_FETCH_ENGINES.join(", ")} ("auto"/"native" are unsupported: non-deterministic and may ignore maxContentTokens)`,
      };
    }
    out.openrouter = { engine: openrouter.engine as OpenRouterFetchEngine };
  }

  return { ok: true, value: out };
}

const LEGACY_TOP_LEVEL_KEYS = ["provider", "model", "providerParams", "webFetch"] as const;

function validateConfig(raw: Record<string, unknown>): LoadResult {
  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    if (raw[key] !== undefined) {
      return {
        ok: false,
        error: `config: top-level '${key}' is no longer supported — configure each tool in its own 'search'/'fetch' section (each with provider/model)`,
      };
    }
  }

  let search: SearchToolConfig | undefined;
  if (raw.search !== undefined) {
    if (!isRecord(raw.search)) return { ok: false, error: "config: 'search' must be an object" };
    const pm = validateProviderModel(raw.search, "search");
    if (!pm.ok) return pm;
    const common = validateSearchCommon(raw.search);
    if (!common.ok) return common;
    const keyed = validateProviderParams(raw.search.providerParams, "search.providerParams");
    if (!keyed.ok) return keyed;

    // Only the active provider's native params are applied; the rest stay
    // configured-but-dormant so switching `provider` needs no other edits.
    search = {
      provider: pm.provider,
      model: pm.model,
      params: common.value,
      providerParams: keyed.value[pm.provider] ?? {},
    };
  }

  let fetch: FetchToolConfig | undefined;
  if (raw.fetch !== undefined) {
    if (!isRecord(raw.fetch)) return { ok: false, error: "config: 'fetch' must be an object" };
    const pm = validateProviderModel(raw.fetch, "fetch");
    if (!pm.ok) return pm;
    if (pm.provider === "openai-codex") {
      return {
        ok: false,
        error: "config: fetch.provider \"openai-codex\" is not supported — the ChatGPT/Codex OAuth backend has no web-fetch capability",
      };
    }
    const core = validateFetchCore(raw.fetch);
    if (!core.ok) return core;
    const keyed = validateProviderParams(raw.fetch.providerParams, "fetch.providerParams");
    if (!keyed.ok) return keyed;
    const perProvider = validateFetchProviderParams(keyed.value);
    if (!perProvider.ok) return perProvider;

    // Only the active provider's passthroughs are applied; the rest stay
    // configured-but-dormant so switching `provider` needs no other edits.
    fetch = {
      provider: pm.provider,
      model: pm.model,
      params: { ...DEFAULT_FETCH_PARAMS, ...core.value, ...perProvider.value[pm.provider] },
    };
  }

  if (!search && !fetch) {
    return {
      ok: false,
      error: "config: no tool configured — add a 'search' and/or 'fetch' section (each with provider/model)",
    };
  }

  return { ok: true, config: { search, fetch } };
}

/** Load, merge, and validate web-access.json (global then project override). */
export function loadConfig(cwd: string): LoadResult {
  const globalPath = join(getAgentDir(), "web-access.json");
  const localPath = join(cwd, CONFIG_DIR_NAME, "web-access.json");

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
