import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "../model-query/query.ts";

export const GENERAL_AGENT_NAME = "General";
export const BUILTIN_GENERAL_AGENT: AgentConfig = {
  name: GENERAL_AGENT_NAME,
  description: "General-purpose subagent with full capabilities and isolated context",
  systemPrompt: `You are a general-purpose worker agent with full capabilities. You operate in an isolated context window to handle delegated tasks without polluting the main conversation.

Work autonomously to complete the assigned task. Use all available tools as needed.

Output format when finished:

## Completed
What was done.

## Files Changed
- \`path/to/file.ts\` - what changed

## Notes (if any)
Anything the main agent should know.

If handing off to another agent, include exact file paths changed and a short list of key functions or types touched.`,
  filePath: "builtin:General",
};

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ModelThinkingLevel;
  systemPrompt: string;
  filePath: string;
}

export interface AgentDiagnostic {
  filePath: string;
  message: string;
}

export interface AgentDiscoveryResult {
  directory: string;
  agents: AgentConfig[];
  diagnostics: AgentDiagnostic[];
}

function diagnostic(filePath: string, message: string): AgentDiagnostic {
  return { filePath, message };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function discoverAgents(directory = join(getAgentDir(), "agents")): AgentDiscoveryResult {
  const agents: AgentConfig[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const names = new Set<string>();

  if (!existsSync(directory)) return { directory, agents: [BUILTIN_GENERAL_AGENT], diagnostics };

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    diagnostics.push(diagnostic(directory, `cannot read directory: ${error instanceof Error ? error.message : String(error)}`));
    return { directory, agents: [BUILTIN_GENERAL_AGENT], diagnostics };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(directory, entry.name);

    try {
      const content = readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
      const name = nonEmptyString(frontmatter.name);
      const description = nonEmptyString(frontmatter.description);
      if (!name || !description) {
        diagnostics.push(diagnostic(filePath, "frontmatter must contain non-empty string fields 'name' and 'description'"));
        continue;
      }
      if (names.has(name)) {
        diagnostics.push(diagnostic(filePath, `duplicate agent name '${name}'`));
        continue;
      }

      const modelValue = frontmatter.model;
      const model = modelValue === undefined ? undefined : nonEmptyString(modelValue);
      if (modelValue !== undefined && !model) {
        diagnostics.push(diagnostic(filePath, "frontmatter field 'model' must be a non-empty string"));
        continue;
      }

      const thinkingValue = frontmatter.thinking;
      const thinking = thinkingValue === undefined ? undefined : nonEmptyString(thinkingValue);
      if (thinking !== undefined && !MODEL_THINKING_LEVELS.includes(thinking as ModelThinkingLevel)) {
        diagnostics.push(
          diagnostic(filePath, `frontmatter field 'thinking' must be one of: ${MODEL_THINKING_LEVELS.join(", ")}`),
        );
        continue;
      }
      if (thinkingValue !== undefined && thinking === undefined) {
        diagnostics.push(diagnostic(filePath, "frontmatter field 'thinking' must be a non-empty string"));
        continue;
      }

      const toolsValue = frontmatter.tools;
      if (toolsValue !== undefined && typeof toolsValue !== "string") {
        diagnostics.push(diagnostic(filePath, "frontmatter field 'tools' must be a comma-separated string"));
        continue;
      }
      const tools = toolsValue
        ?.split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);

      names.add(name);
      agents.push({
        name,
        description,
        tools: tools?.length ? tools : undefined,
        model,
        thinking: thinking as ModelThinkingLevel | undefined,
        systemPrompt: body,
        filePath,
      });
    } catch (error) {
      diagnostics.push(diagnostic(filePath, error instanceof Error ? error.message : String(error)));
    }
  }

  if (!names.has(GENERAL_AGENT_NAME)) agents.unshift(BUILTIN_GENERAL_AGENT);
  return { directory, agents, diagnostics };
}

export function formatAgentList(agents: readonly AgentConfig[], maxItems = 20): string {
  if (!agents.length) return "none";
  const listed = agents.slice(0, maxItems).map((agent) => `${agent.name}: ${agent.description}`);
  if (agents.length > maxItems) listed.push(`…and ${agents.length - maxItems} more`);
  return listed.join("; ");
}
