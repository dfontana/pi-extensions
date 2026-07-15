import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  type AgentDefinition,
  type SubagentConfig,
  type ThinkingLevel,
} from "./contracts.ts";

const DEFINITION_KEYS = new Set([
  "description",
  "display_name",
  "model",
  "thinking",
  "tools",
  "run_in_background",
]);
const CONFIG_KEYS = new Set([
  "maxConcurrentAgents",
  "idleWarningMs",
  "widgetMaxRows",
  "defaultBackground",
  "modelAliases",
]);

export const BUILTIN_DEFINITIONS: AgentDefinition[] = [
  {
    id: "general-purpose",
    displayName: "General",
    description: "General-purpose agent for complex, multi-step work.",
    systemPrompt: "You are a general-purpose subagent. Complete the delegated task autonomously. Inspect the actual repository, follow its instructions, and report concrete results. Do not launch nested subagents.",
    source: "builtin",
  },
  {
    id: "Explore",
    displayName: "Explore",
    description: "Fast read-only role for locating code and answering repository questions.",
    systemPrompt: "You are an exploration subagent. Inspect the repository and answer the delegated question with concrete paths and evidence. Do not edit files or mutate version-control state. Do not launch nested subagents.",
    tools: ["read", "grep", "find", "ls", "bash"],
    source: "builtin",
  },
  {
    id: "Research",
    displayName: "Research",
    description: "Research role with parent-discoverable tools except file mutation and delegation.",
    systemPrompt: "You are a research subagent. Investigate the delegated question thoroughly, use available sources, and return evidence-backed conclusions. Do not edit or write repository files. Do not launch nested subagents.",
    source: "builtin",
  },
  {
    id: "Plan",
    displayName: "Plan",
    description: "Software architecture role for implementation planning.",
    systemPrompt: "You are a software architecture subagent. Inspect the repository and produce a concrete implementation plan with critical files, sequencing, tests, and trade-offs. Do not edit files or mutate version-control state. Do not launch nested subagents.",
    tools: ["read", "grep", "find", "ls", "bash"],
    source: "builtin",
  },
];

function fail(filePath: string, message: string): never {
  throw new Error(`Invalid subagent file ${filePath}: ${message}`);
}

function optionalString(value: unknown, key: string, filePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) fail(filePath, `${key} must be a non-empty string`);
  return value.trim();
}

function parseTools(value: unknown, filePath: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim())) {
    fail(filePath, "tools must be a comma-separated string or string array");
  }
  const result = [...new Set((values as string[]).map((item) => item.trim()))];
  if (result.length === 0) fail(filePath, "tools must not be empty when specified");
  return result;
}

function loadDefinitionFile(filePath: string, source: "user" | "project"): AgentDefinition {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    const content = fs.readFileSync(filePath, "utf8");
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (error) {
    fail(filePath, error instanceof Error ? error.message : String(error));
  }
  for (const key of Object.keys(parsed.frontmatter)) {
    if (!DEFINITION_KEYS.has(key)) fail(filePath, `unknown frontmatter key ${JSON.stringify(key)}`);
  }
  if (!parsed.body.trim()) fail(filePath, "Markdown body must contain a standalone system prompt");
  const id = path.basename(filePath, ".md");
  const description = optionalString(parsed.frontmatter.description, "description", filePath);
  if (!description) fail(filePath, "description is required");
  const thinking = optionalString(parsed.frontmatter.thinking, "thinking", filePath);
  if (thinking && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    fail(filePath, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const background = parsed.frontmatter.run_in_background;
  if (background !== undefined && typeof background !== "boolean") {
    fail(filePath, "run_in_background must be boolean");
  }
  return {
    id,
    displayName: optionalString(parsed.frontmatter.display_name, "display_name", filePath) ?? id,
    description,
    systemPrompt: parsed.body.trim(),
    model: optionalString(parsed.frontmatter.model, "model", filePath),
    thinking: thinking as ThinkingLevel | undefined,
    tools: parseTools(parsed.frontmatter.tools, filePath),
    runInBackground: background as boolean | undefined,
    source,
    filePath,
  };
}

function loadDefinitionDirectory(dir: string, source: "user" | "project"): AgentDefinition[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    fail(dir, error instanceof Error ? error.message : String(error));
  }
  return entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => loadDefinitionFile(path.join(dir, entry.name), source));
}

export function loadAgentDefinitions(cwd: string, trusted: boolean, agentDir = getAgentDir()): Map<string, AgentDefinition> {
  const result = new Map(BUILTIN_DEFINITIONS.map((definition) => [definition.id, definition]));
  for (const definition of loadDefinitionDirectory(path.join(agentDir, "agents"), "user")) {
    result.set(definition.id, definition);
  }
  if (trusted) {
    for (const definition of loadDefinitionDirectory(path.join(cwd, ".pi", "agents"), "project")) {
      result.set(definition.id, definition);
    }
  }
  return result;
}

function readConfig(filePath: string): Partial<SubagentConfig> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(filePath, error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(filePath, "root must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!CONFIG_KEYS.has(key)) fail(filePath, `unknown key ${JSON.stringify(key)}`);
  for (const key of ["maxConcurrentAgents", "idleWarningMs", "widgetMaxRows"] as const) {
    const item = record[key];
    if (item !== undefined && (!Number.isInteger(item) || (item as number) < (key === "idleWarningMs" ? 0 : 1))) {
      fail(filePath, `${key} must be an integer ${key === "idleWarningMs" ? ">= 0" : ">= 1"}`);
    }
  }
  if (record.defaultBackground !== undefined && typeof record.defaultBackground !== "boolean") {
    fail(filePath, "defaultBackground must be boolean");
  }
  if (record.modelAliases !== undefined) {
    if (!record.modelAliases || typeof record.modelAliases !== "object" || Array.isArray(record.modelAliases)) {
      fail(filePath, "modelAliases must be an object");
    }
    for (const [key, item] of Object.entries(record.modelAliases as Record<string, unknown>)) {
      if (!key.trim() || typeof item !== "string" || !item.trim()) fail(filePath, "modelAliases keys and values must be non-empty strings");
    }
  }
  return record as Partial<SubagentConfig>;
}

export function loadSubagentConfig(cwd: string, trusted: boolean, agentDir = getAgentDir()): SubagentConfig {
  const globalPath = path.join(agentDir, "subagents.json");
  const projectPath = path.join(cwd, ".pi", "subagents.json");
  const global = readConfig(globalPath) ?? {};
  const project = trusted ? readConfig(projectPath) ?? {} : {};
  return {
    ...DEFAULT_CONFIG,
    ...global,
    ...project,
    modelAliases: {
      ...DEFAULT_CONFIG.modelAliases,
      ...(global.modelAliases ?? {}),
      ...(project.modelAliases ?? {}),
    },
  };
}
