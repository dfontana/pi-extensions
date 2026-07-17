/**
 * Config loading for the scoped-tools extension.
 *
 * Tool specs are read (never written) from `scoped-tools.json` files, merged
 * in precedence order: `~/.pi/agent/scoped-tools.json` (global, honors
 * PI_AGENT_DIR) then `./.pi/scoped-tools.json` (project). A project entry
 * replaces a same-named global entry wholesale before validation, so an
 * invalid project override drops the tool rather than silently falling back
 * to the global definition.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ParameterSpec {
  type: "string" | "number";
  description: string;
  /** Ran as `bash -c <validationCmd> scoped-tools <value>`; non-zero exit rejects the tool call. */
  validationCmd?: string;
}

export interface HiddenParameterSpec {
  /** Command template evaluated at call time; its stdout becomes the value. */
  valueFromCmd: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ParameterSpec>;
  hiddenParameters: Record<string, HiddenParameterSpec>;
  commandTemplate: string;
  /** Per-subprocess timeout in seconds (default applied by the runner). */
  timeout?: number;
}

export interface LoadResult {
  tools: ToolSpec[];
  errors: string[];
}

const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(name: string, raw: unknown): ToolSpec {
  if (!isRecord(raw)) throw new Error("definition must be an object");
  if (!TOOL_NAME.test(name)) throw new Error("tool name must match [a-zA-Z][a-zA-Z0-9_-]*");
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new Error("missing description");
  }
  if (typeof raw.commandTemplate !== "string" || !raw.commandTemplate.trim()) {
    throw new Error("missing commandTemplate");
  }
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || raw.timeout <= 0)) {
    throw new Error("timeout must be a positive number of seconds");
  }

  // Parameters and hidden parameters share one $UPPER_SNAKE namespace in
  // templates, so names must be unique after uppercasing.
  const seen = new Set<string>();
  const claim = (paramName: string) => {
    if (!PARAM_NAME.test(paramName)) {
      throw new Error(`parameter "${paramName}" must match [a-zA-Z][a-zA-Z0-9_]*`);
    }
    const upper = paramName.toUpperCase();
    if (seen.has(upper)) throw new Error(`parameter "${paramName}" collides with another parameter as $${upper}`);
    seen.add(upper);
  };

  const parameters: Record<string, ParameterSpec> = {};
  if (raw.parameters !== undefined && !isRecord(raw.parameters)) throw new Error("parameters must be an object");
  for (const [paramName, param] of Object.entries(raw.parameters ?? {})) {
    claim(paramName);
    if (!isRecord(param)) throw new Error(`parameter "${paramName}" must be an object`);
    if (param.type !== "string" && param.type !== "number") {
      throw new Error(`parameter "${paramName}" type must be "string" or "number"`);
    }
    if (typeof param.description !== "string") throw new Error(`parameter "${paramName}" missing description`);
    if (param.validationCmd !== undefined && typeof param.validationCmd !== "string") {
      throw new Error(`parameter "${paramName}" validationCmd must be a string`);
    }
    parameters[paramName] = { type: param.type, description: param.description, validationCmd: param.validationCmd };
  }

  const hiddenParameters: Record<string, HiddenParameterSpec> = {};
  if (raw.hiddenParameters !== undefined && !isRecord(raw.hiddenParameters)) {
    throw new Error("hiddenParameters must be an object");
  }
  for (const [paramName, hidden] of Object.entries(raw.hiddenParameters ?? {})) {
    claim(paramName);
    if (!isRecord(hidden) || typeof hidden.valueFromCmd !== "string" || !hidden.valueFromCmd.trim()) {
      throw new Error(`hidden parameter "${paramName}" missing valueFromCmd`);
    }
    hiddenParameters[paramName] = { valueFromCmd: hidden.valueFromCmd };
  }

  return {
    name,
    description: raw.description,
    parameters,
    hiddenParameters,
    commandTemplate: raw.commandTemplate,
    timeout: raw.timeout,
  };
}

/** Merge global then project `scoped-tools.json` (project wins per tool name). */
export function loadScopedTools(cwd: string, agentDir = getAgentDir()): LoadResult {
  const errors: string[] = [];
  const merged = new Map<string, unknown>();
  for (const path of [join(agentDir, "scoped-tools.json"), resolve(cwd, ".pi", "scoped-tools.json")]) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isRecord(parsed)) {
      errors.push(`${path}: expected a top-level object of tool definitions`);
      continue;
    }
    for (const [name, raw] of Object.entries(parsed)) merged.set(name, raw);
  }

  const tools: ToolSpec[] = [];
  for (const [name, raw] of merged) {
    try {
      tools.push(validate(name, raw));
    } catch (error) {
      errors.push(`skipped tool "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tools, errors };
}
