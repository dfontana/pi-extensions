/**
 * Load the global gateway-provider configuration from `~/.pi/agent/gateway.json`.
 * The agent directory comes from pi's `getAgentDir()` helper, so the standard
 * `PI_CODING_AGENT_DIR` override is honored as well.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE = "gateway.json";

export interface GatewayProviderConfig {
  provider: string;
  baseUrl: string;
  authHeader: boolean;
  headers: Record<string, string>;
}

export interface GatewayConfig {
  gateway: string;
  keyCommand: string;
  headers: Record<string, string>;
  providers: GatewayProviderConfig[];
}

export type LoadConfigResult =
  | { ok: true; config: GatewayConfig | undefined }
  | { ok: false; error: string };

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, where: string): ValidationResult<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `config: ${where} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function validateHeaders(value: unknown, where: string): ValidationResult<Record<string, string>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) {
    return { ok: false, error: `config: ${where} must be an object of string values` };
  }
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      return { ok: false, error: `config: ${where}.${key} must be a string` };
    }
  }
  return { ok: true, value: { ...value } as Record<string, string> };
}

function validateAuthHeader(value: unknown, where: string): ValidationResult<boolean> {
  if (value === undefined || value === false || value === "false") return { ok: true, value: false };
  if (value === true || value === "true") return { ok: true, value: true };
  return { ok: false, error: `config: ${where} must be true or false` };
}

function validateConfig(raw: Record<string, unknown>): LoadConfigResult {
  const gateway = nonEmptyString(raw.gateway, "gateway");
  if (!gateway.ok) return gateway;

  const keyCommand = nonEmptyString(raw["key-command"], '"key-command"');
  if (!keyCommand.ok) return keyCommand;

  const headers = validateHeaders(raw.headers, "headers");
  if (!headers.ok) return headers;

  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    return { ok: false, error: "config: providers must be a non-empty array" };
  }

  const providers: GatewayProviderConfig[] = [];
  const providerNames = new Set<string>();
  for (const [index, value] of raw.providers.entries()) {
    const where = `providers[${index}]`;
    if (!isRecord(value)) {
      return { ok: false, error: `config: ${where} must be an object` };
    }

    const provider = nonEmptyString(value.provider, `${where}.provider`);
    if (!provider.ok) return provider;
    if (providerNames.has(provider.value)) {
      return { ok: false, error: `config: duplicate provider "${provider.value}"` };
    }
    providerNames.add(provider.value);

    const rawBaseUrl = nonEmptyString(value.baseUrl, `${where}.baseUrl`);
    if (!rawBaseUrl.ok) return rawBaseUrl;

    const authHeader = validateAuthHeader(value.authHeader, `${where}.authHeader`);
    if (!authHeader.ok) return authHeader;

    const providerHeaders = validateHeaders(value.headers, `${where}.headers`);
    if (!providerHeaders.ok) return providerHeaders;

    providers.push({
      provider: provider.value,
      baseUrl: rawBaseUrl.value.split("$GATEWAY").join(gateway.value),
      authHeader: authHeader.value,
      headers: providerHeaders.value,
    });
  }

  return {
    ok: true,
    config: {
      gateway: gateway.value,
      keyCommand: keyCommand.value,
      headers: headers.value,
      providers,
    },
  };
}

/** Load and validate `gateway.json`; a missing file simply disables this extension. */
export function loadConfig(agentDir = getAgentDir()): LoadConfigResult {
  const path = join(agentDir, CONFIG_FILE);
  if (!existsSync(path)) return { ok: true, config: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: `${path} must contain a JSON object` };
  }
  return validateConfig(parsed);
}
