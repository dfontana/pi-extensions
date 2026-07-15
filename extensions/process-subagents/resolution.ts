import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  DELEGATION_TOOLS,
  type AgentDefinition,
  type PersistedRunSnapshot,
  type SubagentConfig,
  type ThinkingLevel,
} from "./contracts.ts";

export interface ResolvedRoute {
  model: Model<any>;
  modelRequest: PersistedRunSnapshot["modelRequest"];
  thinking: ThinkingLevel;
}

function exactModel(reference: string, available: Model<any>[]): Model<any> {
  const slash = reference.indexOf("/");
  if (slash > 0) {
    const provider = reference.slice(0, slash);
    const id = reference.slice(slash + 1);
    const match = available.find((model) => model.provider === provider && model.id === id);
    if (!match) throw new Error(`Model ${JSON.stringify(reference)} is not available`);
    return match;
  }
  const matches = available.filter((model) => model.id === reference);
  if (matches.length === 0) throw new Error(`Model ID ${JSON.stringify(reference)} is not available`);
  if (matches.length > 1) {
    const routes = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
    throw new Error(`Model ID ${JSON.stringify(reference)} is ambiguous; use one of: ${routes}`);
  }
  return matches[0];
}

export async function resolveRoute(
  ctx: ExtensionContext,
  config: SubagentConfig,
  definition: AgentDefinition,
  callModel: string | undefined,
  callThinking: ThinkingLevel | undefined,
  parentThinking: ThinkingLevel,
  previous?: PersistedRunSnapshot,
): Promise<ResolvedRoute> {
  let source: PersistedRunSnapshot["modelRequest"]["source"];
  let reference: string | undefined;
  if (previous) {
    source = callModel ? "call" : "resume";
    reference = callModel ?? `${previous.resolvedModel.provider}/${previous.resolvedModel.id}`;
  } else if (callModel) {
    source = "call";
    reference = callModel;
  } else if (definition.model) {
    source = "definition";
    reference = definition.model;
  } else {
    source = "parent";
    reference = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  }
  if (!reference) throw new Error("No parent model is active and the subagent did not specify one");
  const substituted = previous && !callModel ? reference : config.modelAliases[reference] ?? reference;
  const model = exactModel(substituted, ctx.modelRegistry.getAvailable());
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Authentication is unavailable for ${model.provider}/${model.id}: ${auth.error}`);

  const thinking = callThinking ?? (previous ? previous.thinking : definition.thinking ?? parentThinking);
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(thinking)) {
    throw new Error(`Thinking level ${thinking} is not supported by ${model.provider}/${model.id}; supported: ${supported.join(", ") || "off only"}`);
  }
  return {
    model,
    modelRequest: { reference: source === "parent" ? undefined : reference, source },
    thinking,
  };
}

export function isChildDiscoverable(tool: ToolInfo): boolean {
  const source = tool.sourceInfo;
  if (source.source === "builtin") return true;
  return source.scope !== "temporary" && source.source !== "sdk" && source.source !== "cli" &&
    source.source !== "inline" && (source.scope === "user" || source.scope === "project");
}

export function resolveTools(
  activeNames: string[],
  allTools: ToolInfo[],
  definition: AgentDefinition,
  persisted?: string[],
): string[] {
  const active = new Set(activeNames);
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const inherited = activeNames.filter((name) => {
    const tool = byName.get(name);
    return tool && isChildDiscoverable(tool) && !DELEGATION_TOOLS.has(name);
  });
  let requested: string[];
  if (persisted) requested = [...persisted];
  else if (definition.tools) requested = [...definition.tools];
  else requested = inherited;

  if (!persisted && definition.id === "Research" && definition.source === "builtin" && !definition.tools) {
    requested = inherited.filter((name) => name !== "edit" && name !== "write");
  }
  for (const name of requested) {
    if (DELEGATION_TOOLS.has(name)) throw new Error(`Delegation tool ${name} cannot be exposed to a child`);
    if (!active.has(name)) throw new Error(`Tool ${name} is not active in the parent`);
    const info = byName.get(name);
    if (!info) throw new Error(`Tool ${name} is unavailable in the parent`);
    if (!isChildDiscoverable(info)) throw new Error(`Tool ${name} is parent-only and cannot be discovered by a child`);
  }
  return [...new Set(requested)].sort();
}
