import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type AgentInput, type ResumeSubagentInput } from "./contracts.ts";
import type { RuntimeView, SubagentRuntime } from "./runtime.ts";

interface CardContext {
  toolCallId: string;
  expanded: boolean;
  invalidate(): void;
}

function output(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function duration(startedAt: string, completedAt?: string): string {
  const milliseconds = Math.max(0, new Date(completedAt ?? Date.now()).getTime() - new Date(startedAt).getTime());
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  return `${Math.round(milliseconds / 60_000)}m`;
}

function compactModel(view: RuntimeView): string {
  const model = view.snapshot.resolvedModel;
  return `${model.provider}/${model.id}`;
}

class AgentCard implements Component {
  private unsubscribe?: () => void;

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly toolCallId: string,
    private readonly fallbackType: string,
    private readonly fallbackDescription: string,
    private readonly theme: Theme,
    private readonly context: CardContext,
  ) {
    this.unsubscribe = runtime.subscribe(() => context.invalidate());
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.runtime.getRunForToolCall(this.toolCallId);
    if (!view) {
      return [truncateToWidth(`${this.theme.fg("warning", "⠹")} ${this.fallbackType} ${this.fallbackDescription}`, width)];
    }
    const { snapshot } = view;
    const running = snapshot.status === "starting" || snapshot.status === "running";
    const icon = running ? this.theme.fg("warning", "⠹") : snapshot.status === "completed"
      ? this.theme.fg("success", "✓") : this.theme.fg("error", "✗");
    const identity = `${snapshot.displayName}[${compactModel(view)}]`;
    let line = `${icon} ${this.theme.fg("toolTitle", this.theme.bold(identity))} ${snapshot.description}`;
    if (running && view.preview) line += ` · ${view.preview.replace(/\s+/g, " ")}`;
    if (!running) {
      if (snapshot.status !== "completed") line += ` · ${snapshot.stopReason ?? snapshot.status}`;
      if (snapshot.cost !== undefined) line += ` · $${snapshot.cost.toFixed(3)}`;
      line += ` · ${duration(snapshot.startedAt, snapshot.completedAt)}`;
    }
    if (!this.context.expanded) return [truncateToWidth(line, width)];
    const details = [
      line,
      `agent: ${snapshot.agentId}`,
      `run: ${snapshot.runId} (#${snapshot.runNumber})`,
      `status: ${snapshot.status}`,
      `route: ${snapshot.resolvedModel.provider}/${snapshot.resolvedModel.id} · thinking ${snapshot.thinking}`,
      `tools: ${snapshot.tools.join(", ") || "none"}`,
      `prompt: ${snapshot.prompt}`,
      snapshot.resultPreview ? `preview: ${snapshot.resultPreview}` : undefined,
      snapshot.usage ? `usage: ${snapshot.usage.total} tokens${snapshot.cost !== undefined ? ` · $${snapshot.cost.toFixed(4)}` : ""}` : undefined,
      snapshot.childSessionFile ? `session: ${snapshot.childSessionFile}` : undefined,
      snapshot.error ? `error: ${snapshot.error}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return details.flatMap((item) => new Text(item, 0, 0).render(width));
  }
}

const ThinkingSchema = StringEnum(THINKING_LEVELS, { description: "Exact thinking level; unsupported levels fail" });

const AgentParameters = Type.Object({
  prompt: Type.String({ description: "Complete standalone task for the child" }),
  description: Type.String({ description: "Short one-line UI label" }),
  subagent_type: Type.String({ description: "Loaded agent definition ID" }),
  model: Type.Optional(Type.String({ description: "Configured alias, provider/model-id, or unique exact bare model ID" })),
  thinking: Type.Optional(ThinkingSchema),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return after durable acceptance instead of waiting" })),
});

const ResumeParameters = Type.Object({
  agent_id: Type.String({ description: "Existing terminal agent ID" }),
  prompt: Type.String({ description: "Required new instruction for the same child session" }),
  model: Type.Optional(Type.String({ description: "Optional exact model override" })),
  thinking: Type.Optional(ThinkingSchema),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return after durable acceptance; defaults to false" })),
});

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentRuntime): void {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Start a durable process-based subagent from a loaded Markdown definition. Each run owns a persisted Pi RPC session. Use background mode for independent work and get_subagent_result to inspect or wait. Children cannot delegate recursively.",
    promptSnippet: "Start a durable isolated subagent process.",
    parameters: AgentParameters,
    executionMode: "parallel",
    renderShell: "self",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return output(await runtime.start(toolCallId, params as AgentInput, signal, ctx));
    },
    renderCall(args, theme, context) {
      return new AgentCard(runtime, context.toolCallId, args.subagent_type || "Agent", args.description || "starting", theme, context);
    },
    renderResult() { return new Container(); },
  });

  pi.registerTool({
    name: "resume_subagent",
    label: "Resume subagent",
    description: "Resume a terminal durable subagent in its existing child session. Keeps the agent/session IDs and creates a new run ID. Rejects running agents and missing or malformed sessions.",
    parameters: ResumeParameters,
    executionMode: "parallel",
    renderShell: "self",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return output(await runtime.resume(toolCallId, params as ResumeSubagentInput, signal, ctx));
    },
    renderCall(args, theme, context) {
      return new AgentCard(runtime, context.toolCallId, "Resume", args.agent_id || "unknown", theme, context);
    },
    renderResult() { return new Container(); },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get subagent result",
    description: "Get the latest run for an agent. Defaults to an immediate status check; wait=true blocks until terminal without stopping the child if the wait is cancelled. Terminal fetches are idempotent and consume passive notifications.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Agent ID returned by Agent" }),
      wait: Type.Optional(Type.Boolean({ description: "Wait without a hard timeout until terminal; default false" })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return output(await runtime.getResult(params.agent_id, params.wait ?? false, signal, ctx));
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop subagent",
    description: "Abort and terminate the latest running run for an agent. Stopping an already terminal agent is idempotent; unknown IDs fail.",
    parameters: Type.Object({ agent_id: Type.String({ description: "Agent ID returned by Agent" }) }),
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return output(await runtime.stop(params.agent_id, ctx));
    }
  });
}
