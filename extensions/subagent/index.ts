import { join } from "node:path";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  GENERAL_AGENT_NAME,
  THINKING_LEVELS,
  discoverAgents,
  formatAgentList,
  type AgentDiagnostic,
} from "./agents.ts";
import {
  SUBAGENT_CHILD_ENV,
  finalOutput,
  formatToolCall,
  resultFailed,
  resultOutput,
  runPiSubagent,
  type AgentResult,
  type RunRequest,
  type SubagentRunner,
} from "./process.ts";
import { collectSubagentEnvironment } from "./environment.ts";
import { aggregateUsage, emptyTrackedUsage, formatAggregateUsage, formatUsage } from "./usage.ts";
import { resolveModelReference, thinkingFromModelReference } from "../model-query/query.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
const COLLAPSED_SINGLE_ITEMS = 10;
const COLLAPSED_PARALLEL_ITEMS = 5;
const COLLAPSED_TASK_LENGTH = 120;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
interface SubagentRowState {
  singleResult?: AgentResult;
  singleDone?: boolean;
  singleError?: boolean;
  headingRefreshPending?: boolean;
}

interface TaskRequest {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
}

interface SubagentParams extends TaskRequest {
  tasks?: TaskRequest[];
}

interface SubagentDetails {
  mode: "single" | "parallel";
  agentsDirectory: string;
  diagnostics: AgentDiagnostic[];
  results: AgentResult[];
}

interface DisplayItem {
  type: "text" | "toolCall";
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface SubagentExtensionOptions {
  run?: SubagentRunner;
  agentsDirectory?: string;
}

const ThinkingSchema = Type.Unsafe<ModelThinkingLevel>({
  type: "string",
  enum: [...THINKING_LEVELS],
  description: "Thinking level override. Agent frontmatter and then the parent session are used when omitted.",
});

const TaskSchema = Type.Object({
  agent: Type.String({ minLength: 1, description: "Name of a global agent to invoke" }),
  task: Type.String({ minLength: 1, description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory; defaults to the parent cwd" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Pi CLI model reference override" })),
  thinking: Type.Optional(ThinkingSchema),
});

const Parameters = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1, description: "Agent name for single mode" })),
  task: Type.Optional(Type.String({ minLength: 1, description: "Delegated task for single mode" })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory for single mode" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Pi CLI model reference override for single mode" })),
  thinking: Type.Optional(ThinkingSchema),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      minItems: 1,
      maxItems: MAX_PARALLEL_TASKS,
      description: `Parallel tasks (maximum ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} concurrent)`,
    }),
  ),
});

function parentDefaults(ctx: ExtensionContext): { model?: string; thinking?: ModelThinkingLevel } {
  return {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking: ctx.thinkingLevel,
  };
}

function contextWindowForModel(
  model: string | undefined,
  snapshot: {
    current?: { provider: string; id: string; contextWindow: number };
    available: readonly { provider: string; id: string; contextWindow: number }[];
  },
): number | undefined {
  if (!model) return undefined;
  const match = snapshot.available.find((candidate) => `${candidate.provider}/${candidate.id}` === model)
    ?? (snapshot.current && `${snapshot.current.provider}/${snapshot.current.id}` === model ? snapshot.current : undefined);
  return match?.contextWindow;
}

function hasThinkingSuffix(model: string | undefined): boolean {
  return thinkingFromModelReference(model) !== undefined;
}

function resolveThinking(
  task: TaskRequest,
  agent: { model?: string; thinking?: ModelThinkingLevel },
  parentThinking: ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (task.thinking !== undefined) return task.thinking;
  if (hasThinkingSuffix(task.model)) return undefined;
  if (agent.thinking !== undefined) return agent.thinking;
  if (task.model === undefined && hasThinkingSuffix(agent.model)) return undefined;
  return parentThinking;
}

function validateMode(params: SubagentParams): "single" | "parallel" {
  const anySingleField = [params.agent, params.task, params.cwd, params.model, params.thinking].some(
    (value) => value !== undefined,
  );
  const completeSingle = Boolean(params.agent?.trim() && params.task?.trim());
  const hasParallel = params.tasks !== undefined;

  if (hasParallel && anySingleField) throw new Error("Provide either agent + task or tasks, not both");
  if (hasParallel) {
    if (!params.tasks?.length) throw new Error("Parallel mode requires at least one task");
    if (params.tasks.length > MAX_PARALLEL_TASKS) {
      throw new Error(`Too many parallel tasks (${params.tasks.length}); maximum is ${MAX_PARALLEL_TASKS}`);
    }
    return "parallel";
  }
  if (!completeSingle) throw new Error("Single mode requires non-empty agent and task fields");
  return "single";
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function placeholder(task: TaskRequest, cwd: string): AgentResult {
  return {
    agent: task.agent,
    task: task.task,
    cwd: task.cwd ?? cwd,
    exitCode: -1,
    status: "queued",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(),
    model: task.model,
    thinking: task.thinking,
  };
}

function makeDetails(
  mode: "single" | "parallel",
  agentsDirectory: string,
  diagnostics: AgentDiagnostic[],
  results: AgentResult[],
): SubagentDetails {
  return { mode, agentsDirectory, diagnostics, results };
}

function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= PER_TASK_OUTPUT_CAP) return output;
  let value = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(value, "utf8") > PER_TASK_OUTPUT_CAP) value = value.slice(0, -1);
  return `${value}\n\n[Output truncated: ${bytes - Buffer.byteLength(value, "utf8")} bytes omitted. Full output is preserved in tool details.]`;
}

function displayItems(messages: readonly Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (part.type === "toolCall") {
        items.push({ type: "toolCall", name: part.name, arguments: part.arguments });
      }
    }
  }
  return items;
}

function notifyDiagnostics(ctx: ExtensionContext, diagnostics: readonly AgentDiagnostic[]): void {
  if (!diagnostics.length) return;
  const preview = diagnostics
    .slice(0, 3)
    .map((item) => `${item.filePath}: ${item.message}`)
    .join("\n");
  const rest = diagnostics.length > 3 ? `\n…and ${diagnostics.length - 3} more` : "";
  ctx.ui.notify(`subagent: skipped ${diagnostics.length} invalid agent definition(s)\n${preview}${rest}`, "warning");
}

function renderItems(
  items: readonly DisplayItem[],
  limit: number | undefined,
  expanded: boolean,
  color: (name: any, text: string) => string,
): string {
  const visible = limit ? items.slice(-limit) : items;
  const omitted = items.length - visible.length;
  const lines: string[] = [];
  if (omitted) lines.push(color("muted", `… ${omitted} earlier items`));
  for (const item of visible) {
    if (item.type === "toolCall") lines.push(color("muted", `→ ${formatToolCall(item.name!, item.arguments ?? {})}`));
    else {
      const text = expanded ? item.text! : item.text!.split("\n").slice(0, 3).join("\n");
      const preview = !expanded && text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
      lines.push(color("toolOutput", preview));
    }
  }
  return lines.join("\n");
}

function modelThinkingSummary(model: string | undefined, thinking: ModelThinkingLevel | undefined): string {
  const suffix = model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1] as ModelThinkingLevel | undefined;
  const modelName = model?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "").split("/").at(-1) ?? "default";
  return `${modelName} ${thinking ?? suffix ?? "default"}`;
}

function isWorking(item: AgentResult, isPartial: boolean, mode: "single" | "parallel"): boolean {
  return item.status === "running" || (mode === "single" && isPartial && item.status !== "done");
}

function agentIcon(
  item: AgentResult,
  working: boolean,
  color: (name: any, text: string) => string,
): string {
  if (working) return color("warning", "●");
  if (item.status === "queued") return color("muted", "·");
  return resultFailed(item) ? color("error", "✗") : color("success", "✓");
}

function truncatedTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > COLLAPSED_TASK_LENGTH ? `${compact.slice(0, COLLAPSED_TASK_LENGTH - 1)}…` : compact;
}

function agentSummaryLines(
  item: AgentResult,
  icon: string,
  theme: { fg: (name: any, text: string) => string; bold: (text: string) => string },
): string[] {
  const usage = formatUsage(item.usage);
  return [
    `${icon} ${theme.fg("toolTitle", theme.bold(item.agent))} ${theme.fg("dim", modelThinkingSummary(item.model, item.thinking))}`,
    `  ${theme.fg("dim", usage || "usage pending")}`,
    `  ${theme.fg("muted", "Prompt: ")}${theme.fg("dim", truncatedTask(item.task))}`,
  ];
}

function agentParameterLines(
  item: AgentResult,
  theme: { fg: (name: any, text: string) => string },
): string[] {
  return [
    `${theme.fg("muted", "Agent: ")}${theme.fg("dim", item.agent)}`,
    `${theme.fg("muted", "Model: ")}${theme.fg("dim", item.model ?? "default")}`,
    `${theme.fg("muted", "Thinking: ")}${theme.fg("dim", item.thinking ?? "default")}`,
    `${theme.fg("muted", "Cwd: ")}${theme.fg("dim", item.cwd)}`,
    `${theme.fg("muted", "Task: ")}${theme.fg("dim", item.task)}`,
  ];
}

function renderError(item: AgentResult, color: (name: any, text: string) => string): string | undefined {
  return resultFailed(item) ? color("error", resultOutput(item)) : undefined;
}

function renderToolCalls(item: AgentResult, color: (name: any, text: string) => string): string {
  const summaries = item.toolCalls ?? displayItems(item.messages)
    .filter((display): display is DisplayItem & { type: "toolCall" } => display.type === "toolCall")
    .map((display) => formatToolCall(display.name!, display.arguments ?? {}));
  const lines = summaries.map((summary) => color("muted", `→ ${summary}`));
  if (item.omittedToolCalls) {
    lines.push(color("muted", `… ${item.omittedToolCalls} later tool call${item.omittedToolCalls === 1 ? "" : "s"} omitted`));
  }
  return lines.join("\n");
}

function latestOutput(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const output = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (output) return output;
  }
  return "";
}

interface RenderTheme {
  fg(name: any, text: string): string;
  bold(text: string): string;
}

function updateText(component: Text, previous: string, next: string): string {
  if (previous !== next) component.setText(next);
  return next;
}

class ExpandedAgentBlock extends Container {
  private readonly heading = new Text("", 0, 0);
  private readonly parameters = new Text("", 0, 0);
  private readonly usage = new Text("", 0, 0);
  private readonly calls = new Text("", 0, 0);
  private readonly output = new Markdown("", 0, 0, getMarkdownTheme());
  private readonly status = new Text("", 0, 0);
  private headingText = "";
  private parametersText = "";
  private usageText = "";
  private callsText = "";
  private outputText = "";
  private statusText = "";

  constructor(private readonly showHeading: boolean) {
    super();
    if (showHeading) {
      this.addChild(new Spacer(1));
      this.addChild(this.heading);
    }
    this.addChild(this.parameters);
    this.addChild(this.usage);
    this.addChild(this.calls);
    this.addChild(new Spacer(1));
    this.addChild(this.output);
    this.addChild(this.status);
  }

  update(item: AgentResult, working: boolean, icon: string, theme: RenderTheme): void {
    const heading = this.showHeading
      ? `${icon} ${theme.fg("toolTitle", theme.bold(item.agent))}`
      : "";
    const parameters = agentParameterLines(item, theme).join("\n");
    const usage = `${theme.fg("muted", "Usage: ")}${theme.fg("dim", formatUsage(item.usage) || "usage pending")}`;
    const calls = renderToolCalls(item, theme.fg.bind(theme));
    const output = working || item.status === "queued" ? "" : finalOutput(item.messages);
    const error = working || item.status === "queued" ? undefined : renderError(item, theme.fg.bind(theme));
    const status = error
      ? `${theme.fg("muted", "Error: ")}${error}`
      : working
        ? theme.fg("muted", "(working…)")
        : item.status === "queued"
          ? theme.fg("muted", "(queued…)")
          : output
            ? ""
            : theme.fg("muted", "(no output)");

    this.headingText = updateText(this.heading, this.headingText, heading);
    this.parametersText = updateText(this.parameters, this.parametersText, parameters);
    this.usageText = updateText(this.usage, this.usageText, usage);
    this.callsText = updateText(this.calls, this.callsText, calls);
    if (this.outputText !== output) {
      this.output.setText(output);
      this.outputText = output;
    }
    this.statusText = updateText(this.status, this.statusText, status);
  }
}

class ExpandedSubagentResult extends Container {
  private readonly top = new Text("", 0, 0);
  private readonly total = new Text("", 0, 0);
  private blocks: ExpandedAgentBlock[] = [];
  private mode?: "single" | "parallel";
  private topText = "";
  private totalText = "";

  update(details: SubagentDetails, isPartial: boolean, theme: RenderTheme): void {
    if (this.mode !== details.mode || this.blocks.length !== details.results.length) {
      this.clear();
      this.blocks = [];
      this.mode = details.mode;
      this.addChild(this.top);
      for (let index = 0; index < details.results.length; index++) {
        const block = new ExpandedAgentBlock(details.mode === "parallel");
        this.blocks.push(block);
        this.addChild(block);
      }
      if (details.mode === "parallel") {
        this.addChild(new Spacer(1));
        this.addChild(this.total);
      }
    }

    const unfinished = details.results.filter((item) => item.exitCode === -1).length;
    const succeeded = details.results.filter((item) => item.exitCode !== -1 && !resultFailed(item)).length;
    const failed = details.results.filter((item) => item.exitCode !== -1 && resultFailed(item)).length;
    const top = details.mode === "single"
      ? theme.fg("muted", "── Parameters ──")
      : `${unfinished ? theme.fg("warning", "●") : failed ? theme.fg("warning", "◐") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", unfinished ? `${details.results.length - unfinished}/${details.results.length} finished` : `${succeeded}/${details.results.length} succeeded`)}`;
    this.topText = updateText(this.top, this.topText, top);

    details.results.forEach((item, index) => {
      const working = isWorking(item, isPartial, details.mode);
      this.blocks[index].update(item, working, agentIcon(item, working, theme.fg.bind(theme)), theme);
    });

    const total = details.mode === "parallel" && !unfinished
      ? formatAggregateUsage(details.results.map((item) => item.usage))
      : "";
    this.totalText = updateText(this.total, this.totalText, total ? theme.fg("dim", `Total: ${total}`) : "");
  }
}

class RetainedText extends Text {
  private value = "";

  update(value: string): void {
    if (this.value === value) return;
    this.value = value;
    this.setText(value);
  }
}

function retainedText(lastComponent: unknown, text: string): Text {
  const component = lastComponent instanceof RetainedText ? lastComponent : new RetainedText("", 0, 0);
  component.update(text);
  return component;
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}) {
  const run = options.run ?? runPiSubagent;

  return (pi: ExtensionAPI) => {
    if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

    const initialDiscovery = discoverAgents(options.agentsDirectory);
    const runChild = (request: RunRequest) => {
      const update = (result: AgentResult): void => {
        if (request.contextWindow !== undefined && result.usage.contextWindow === undefined) {
          result.usage.contextWindow = request.contextWindow;
        }
        request.onUpdate?.(result);
      };
      return run({
        ...request,
        environment: collectSubagentEnvironment(),
        onUpdate: request.onUpdate ? update : undefined,
      }).then((result) => {
        if (request.contextWindow !== undefined && result.usage.contextWindow === undefined) {
          result.usage.contextWindow = request.contextWindow;
        }
        return result;
      });
    };

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate work to global agents in isolated Pi processes.",
        "Use agent + task for one subagent or tasks for parallel execution.",
        "Each task may override cwd, model (Pi CLI syntax), and thinking; defaults come from agent frontmatter then the parent session.",
        `Available agents from ${initialDiscovery.directory}: ${formatAgentList(initialDiscovery.agents)}.`,
      ].join(" "),
      parameters: Parameters,

      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as SubagentParams;
        const mode = validateMode(params);
        const discovery = discoverAgents(options.agentsDirectory);
        notifyDiagnostics(ctx, discovery.diagnostics);
        const defaults = parentDefaults(ctx);
        const refreshResult = await ctx.modelRegistry.refresh({ signal });
        if (refreshResult.aborted) {
          signal?.throwIfAborted();
          throw new Error("Model refresh was aborted");
        }
        signal?.throwIfAborted();
        const modelSnapshot = { current: ctx.model, available: ctx.modelRegistry.getAvailable() };
        const resolveRequest = (task: TaskRequest) => {
          const agent =
            discovery.agents.find((candidate) => candidate.name.toLowerCase() === task.agent.toLowerCase()) ??
            discovery.agents.find((candidate) => candidate.name === GENERAL_AGENT_NAME)!;
          const rawModel = task.model ?? agent.model;
          const requestedThinking = resolveThinking(task, agent, defaults.thinking);
          const resolved = rawModel
            ? resolveModelReference(rawModel, modelSnapshot, requestedThinking)
            : { model: defaults.model, thinking: requestedThinking };
          return {
            agent,
            task: task.task,
            cwd: task.cwd ?? ctx.cwd,
            model: resolved.model,
            thinking: resolved.thinking,
            contextWindow: contextWindowForModel(resolved.model, modelSnapshot),
            signal,
          };
        };

        if (mode === "single") {
          const request = resolveRequest(params);
          onUpdate?.({
            content: [{ type: "text", text: "(starting…)" }],
            details: makeDetails("single", discovery.directory, discovery.diagnostics, [
              {
                agent: request.agent.name,
                task: request.task,
                cwd: request.cwd,
                exitCode: -1,
                status: "running",
                messages: [],
                stderr: "",
                usage: emptyTrackedUsage(request.contextWindow),
                model: request.model,
                thinking: request.thinking,
              },
            ]),
          });
          const result = await runChild({
            ...request,
            onUpdate: onUpdate
              ? (partial) =>
                  onUpdate({
                    content: [{ type: "text", text: truncateOutput(finalOutput(partial.messages) || "(running…)") }],
                    details: makeDetails("single", discovery.directory, discovery.diagnostics, [
                      { ...partial, status: "running" },
                    ]),
                  })
              : undefined,
          });
          result.status = "done";
          return {
            content: [{ type: "text", text: truncateOutput(resultOutput(result)) }],
            details: makeDetails("single", discovery.directory, discovery.diagnostics, [result]),
            usage: result.usage.usage,
          };
        }

        const tasks = params.tasks!;
        const allResults = tasks.map((task) => placeholder(task, ctx.cwd));
        let emitTimer: ReturnType<typeof setTimeout> | undefined;
        const flushEmit = () => {
          if (emitTimer) clearTimeout(emitTimer);
          emitTimer = undefined;
          if (!onUpdate) return;
          const done = allResults.filter((result) => result.exitCode !== -1).length;
          onUpdate({
            content: [{ type: "text", text: `Parallel subagents: ${done}/${allResults.length} finished` }],
            details: makeDetails("parallel", discovery.directory, discovery.diagnostics, [...allResults]),
          });
        };
        const emit = () => {
          if (!onUpdate || emitTimer) return;
          emitTimer = setTimeout(flushEmit, 50);
          emitTimer.unref?.();
        };

        // Resolve every agent before starting work so a bad batch cannot partially execute.
        const requests = tasks.map(resolveRequest);
        const results = await mapConcurrent(requests, MAX_CONCURRENCY, async (request, index) => {
          allResults[index] = {
            ...allResults[index],
            agent: request.agent.name,
            model: request.model,
            thinking: request.thinking,
            status: "running",
          };
          allResults[index].usage.contextWindow = request.contextWindow;
          emit();
          const result = await runChild({
            ...request,
            onUpdate: (partial) => {
              allResults[index] = { ...partial, status: "running" };
              emit();
            },
          });
          result.status = "done";
          allResults[index] = result;
          emit();
          return result;
        });

        flushEmit();
        const succeeded = results.filter((result) => !resultFailed(result)).length;
        if (signal?.aborted) throw new Error("Subagent execution was aborted");

        const summaries = results.map((result) => {
          const status = resultFailed(result) ? "failed" : "completed";
          return `### [${result.agent}] ${status}\n\n${truncateOutput(resultOutput(result))}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel subagents: ${succeeded}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel", discovery.directory, discovery.diagnostics, results),
          usage: aggregateUsage(results.map((result) => result.usage)),
        };
      },

      renderCall(args, theme, context) {
        if (args.tasks?.length) {
          return retainedText(
            context.lastComponent,
            `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length})`)}`,
          );
        }

        const state = context.state as SubagentRowState;
        const item = state.singleResult;
        const icon = state.singleDone
          ? state.singleError ? theme.fg("error", "✗") : theme.fg("success", "✓")
          : theme.fg("warning", "●");
        const agent = item?.agent ?? args.agent ?? "…";
        const metadata = modelThinkingSummary(item?.model ?? args.model, item?.thinking ?? args.thinking);
        return retainedText(
          context.lastComponent,
          `${theme.fg("toolTitle", theme.bold("subagent"))} ${icon} ${theme.fg("toolTitle", theme.bold(agent))} ${theme.fg("dim", metadata)}`,
        );
      },

      renderResult(result, { expanded, isPartial }, theme, context) {
        const details = result.details as SubagentDetails | undefined;
        if (!details?.results.length) {
          const first = result.content[0];
          return retainedText(context.lastComponent, first?.type === "text" ? first.text : "(no output)");
        }

        const state = context.state as SubagentRowState;

        if (details.mode === "single") {
          const item = details.results[0];
          const singleDone = !isPartial && item.status === "done";
          const singleError = singleDone && resultFailed(item);
          if (
            state.singleResult?.model !== item.model ||
            state.singleResult?.thinking !== item.thinking ||
            state.singleResult?.agent !== item.agent ||
            state.singleDone !== singleDone ||
            state.singleError !== singleError
          ) {
            state.singleResult = item;
            state.singleDone = singleDone;
            state.singleError = singleError;
            if (!state.headingRefreshPending) {
              state.headingRefreshPending = true;
              queueMicrotask(() => {
                state.headingRefreshPending = false;
                context.invalidate();
              });
            }
          }
          const working = isWorking(item, isPartial, "single");
          if (!expanded) {
            const error = renderError(item, theme.fg.bind(theme));
            const latest = latestOutput(item.messages);
            const output = error ?? (latest
              ? renderItems([{ type: "text", text: latest }], COLLAPSED_SINGLE_ITEMS, false, theme.fg.bind(theme))
              : theme.fg("muted", working ? "(working…)" : "(no output)"));
            return retainedText(context.lastComponent, [
              theme.fg("dim", formatUsage(item.usage) || "usage pending"),
              `${theme.fg("muted", "Prompt: ")}${theme.fg("dim", truncatedTask(item.task))}`,
              output,
            ].join("\n"));
          }

          const component = context.lastComponent instanceof ExpandedSubagentResult
            ? context.lastComponent
            : new ExpandedSubagentResult();
          component.update(details, isPartial, theme);
          return component;
        }

        const running = details.results.filter((item) => item.exitCode === -1).length;
        const succeeded = details.results.filter((item) => item.exitCode !== -1 && !resultFailed(item)).length;
        const failed = details.results.filter((item) => item.exitCode !== -1 && resultFailed(item)).length;
        const icon = running
          ? theme.fg("warning", "●")
          : failed
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = running
          ? `${details.results.length - running}/${details.results.length} finished`
          : `${succeeded}/${details.results.length} succeeded`;

        if (expanded) {
          const component = context.lastComponent instanceof ExpandedSubagentResult
            ? context.lastComponent
            : new ExpandedSubagentResult();
          component.update(details, isPartial, theme);
          return component;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const item of details.results) {
          const working = isWorking(item, isPartial, "parallel");
          const itemIcon = agentIcon(item, working, theme.fg.bind(theme));
          const texts = displayItems(item.messages).filter((display) => display.type === "text");
          const error = renderError(item, theme.fg.bind(theme));
          text += `\n\n${agentSummaryLines(item, itemIcon, theme).join("\n")}`;
          text += `\n${error ?? (texts.length ? renderItems(texts, COLLAPSED_PARALLEL_ITEMS, false, theme.fg.bind(theme)) : theme.fg("muted", working ? "(working…)" : item.status === "queued" ? "(queued…)" : "(no output)"))}`;
        }
        if (!running) {
          const total = formatAggregateUsage(details.results.map((item) => item.usage));
          if (total) text += `\n\n${theme.fg("dim", `Total: ${total}`)}`;
        }
        return retainedText(context.lastComponent, text);
      },
    });
  };
}

export default createSubagentExtension();
