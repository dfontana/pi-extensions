import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  GENERAL_AGENT_NAME,
  discoverAgents,
  formatAgentList,
  type AgentConfig,
  type AgentDiagnostic,
} from "./agents.ts";
import {
  SUBAGENT_CHILD_ENV,
  abortedResult,
  finalOutput,
  resultFailed,
  resultOutput,
  runPiSubagent,
  type AgentResult,
  type RunRequest,
  type SubagentRunner,
} from "./process.ts";
import { collectSubagentEnvironment } from "./environment.ts";
import { SubagentScheduler } from "./scheduler.ts";
import { emptyTrackedUsage, formatUsage } from "./usage.ts";
import { MODEL_THINKING_LEVELS, resolveModelReference, thinkingFromModelReference } from "../model-query/query.ts";

export { MAX_ACTIVE_CHILDREN, MAX_OUTSTANDING_CALLS } from "./scheduler.ts";

const COLLAPSED_TASK_LENGTH = 120;
const PER_CALL_OUTPUT_CAP = 50 * 1024;

interface SubagentRowState {
  result?: AgentResult;
  headingKey?: string;
  headingRefreshPending?: boolean;
}

interface SubagentParams {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
}

export interface SubagentDetails {
  result: AgentResult;
}

interface LegacySubagentDetails {
  mode?: "single" | "parallel";
  agentsDirectory?: string;
  diagnostics?: AgentDiagnostic[];
  results?: AgentResult[];
}

export interface SubagentExtensionOptions {
  run?: SubagentRunner;
  agentsDirectory?: string;
}

const ThinkingSchema = Type.Unsafe<ModelThinkingLevel>({
  type: "string",
  enum: [...MODEL_THINKING_LEVELS],
  description: "Thinking level override. Agent frontmatter and then the parent session are used when omitted.",
});

const Parameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Name of a global agent to invoke" }),
  task: Type.String({ minLength: 1, description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory; defaults to the parent cwd" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Pi CLI model reference override" })),
  thinking: Type.Optional(ThinkingSchema),
}, { additionalProperties: false });

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

function resolveThinking(
  request: SubagentParams,
  agent: Pick<AgentConfig, "model" | "thinking">,
  parentThinking: ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (request.thinking !== undefined) return request.thinking;
  if (thinkingFromModelReference(request.model) !== undefined) return undefined;
  if (agent.thinking !== undefined) return agent.thinking;
  if (request.model === undefined && thinkingFromModelReference(agent.model) !== undefined) return undefined;
  return parentThinking;
}

function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= PER_CALL_OUTPUT_CAP) return output;
  let value = output.slice(0, PER_CALL_OUTPUT_CAP);
  while (Buffer.byteLength(value, "utf8") > PER_CALL_OUTPUT_CAP) value = value.slice(0, -1);
  return `${value}\n\n[Output truncated: ${bytes - Buffer.byteLength(value, "utf8")} bytes omitted. Retained tool details are separately bounded.]`;
}

function latestOutputPreview(output: string, color: (name: any, text: string) => string): string {
  const preview = output.split("\n").slice(0, 3).join("\n");
  return color("toolOutput", preview.length > 1_000 ? `${preview.slice(0, 1_000)}…` : preview);
}

function notifyDiagnostics(
  ctx: ExtensionContext,
  diagnostics: readonly AgentDiagnostic[],
  notified: Set<string>,
): void {
  const fresh = diagnostics.filter((item) => {
    const key = `${item.filePath}\0${item.message}`;
    if (notified.has(key)) return false;
    notified.add(key);
    return true;
  });
  if (!fresh.length) return;
  const preview = fresh
    .slice(0, 3)
    .map((item) => `${item.filePath}: ${item.message}`)
    .join("\n");
  const rest = fresh.length > 3 ? `\n…and ${fresh.length - 3} more` : "";
  ctx.ui.notify(`subagent: skipped ${fresh.length} invalid agent definition(s)\n${preview}${rest}`, "warning");
}

function modelThinkingSummary(model: string | undefined, thinking: ModelThinkingLevel | undefined): string {
  const suffix = thinkingFromModelReference(model);
  const modelName = (model && suffix ? model.slice(0, -(suffix.length + 1)) : model)?.split("/").at(-1) ?? "default";
  return `${modelName} ${thinking ?? suffix ?? "default"}`;
}

function isComplete(item: AgentResult): boolean {
  if (item.status === undefined) return item.exitCode !== -1;
  return item.status === "done" || item.status === "aborted" || item.status === "failed" || item.status === "spawn-error";
}

function isWorking(item: AgentResult, isPartial: boolean): boolean {
  return item.status === "queued" || item.status === "running" || (isPartial && !isComplete(item));
}

function agentIcon(
  item: AgentResult,
  color: (name: any, text: string) => string,
  forceError = false,
): string {
  if (forceError) return color("error", "✗");
  if (item.status === "queued") return color("muted", "·");
  if (item.status === "running" || !isComplete(item)) return color("warning", "●");
  return resultFailed(item) ? color("error", "✗") : color("success", "✓");
}

function truncatedTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > COLLAPSED_TASK_LENGTH ? `${compact.slice(0, COLLAPSED_TASK_LENGTH - 1)}…` : compact;
}

function expandedContextLines(
  item: AgentResult,
  theme: { fg: (name: any, text: string) => string },
): string[] {
  return [
    `${theme.fg("muted", "Cwd: ")}${theme.fg("dim", item.cwd)}`,
    `${theme.fg("muted", "Task: ")}${theme.fg("dim", item.task)}`,
  ];
}

function renderError(item: AgentResult, color: (name: any, text: string) => string): string | undefined {
  return isComplete(item) && resultFailed(item) ? color("error", resultOutput(item)) : undefined;
}

function diagnosticsLines(item: AgentResult, theme: RenderTheme): string {
  const proc = item.process;
  if (!proc) return "";
  const fg = theme.fg.bind(theme);
  const term = proc.termination;
  const exitCode = term?.exitCode !== undefined && term.exitCode !== null ? String(term.exitCode) : "n/a";
  const lines = [
    `${fg("muted", "Status: ")}${fg("dim", item.status ?? "failed")}`,
    `${fg("muted", "Exit code: ")}${fg("dim", exitCode)}`,
    `${fg("muted", "Signal: ")}${fg("dim", term?.signal ?? "none")}`,
  ];
  if (proc.durationMs !== undefined) lines.push(`${fg("muted", "Duration: ")}${fg("dim", `${proc.durationMs} ms`)}`);
  lines.push(`${fg("muted", "Messages: ")}${fg("dim", String(item.messages.length))}`);
  lines.push(`${fg("muted", "stderr: ")}${fg("dim", item.stderr.trim() ? "present" : "empty")}`);
  if (proc.spawnError) lines.push(`${fg("muted", "Spawn error: ")}${fg("dim", proc.spawnError)}`);
  if (proc.protocolErrors) lines.push(`${fg("muted", "Protocol errors: ")}${fg("dim", String(proc.protocolErrors))}`);
  if (proc.stdoutBytesIgnored) lines.push(`${fg("muted", "Stdout truncated: ")}${fg("dim", `${proc.stdoutBytesIgnored} bytes`)}`);
  if (proc.stdoutTail) lines.push(`${fg("muted", "Stdout tail:")}\n${fg("dim", proc.stdoutTail)}`);
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
}

function updateText(component: Text, previous: string, next: string): string {
  if (previous !== next) component.setText(next);
  return next;
}

const EXPANDED_ACTIVITY_LINES = 10;

class ExpandedActivity {
  private working = false;
  private latest = "";

  update(working: boolean, latest: string | undefined): void {
    this.working = working;
    this.latest = latest ?? "";
  }

  render(width: number): string[] {
    if (!this.working) return [];
    if (width <= 0) return Array.from({ length: EXPANDED_ACTIVITY_LINES }, () => "");
    const lines = this.latest
      ? wrapTextWithAnsi(this.latest, width).map((line) => truncateToWidth(line, width, ""))
      : [];
    const visible = lines.slice(0, EXPANDED_ACTIVITY_LINES);
    if (lines.length > EXPANDED_ACTIVITY_LINES) {
      const last = EXPANDED_ACTIVITY_LINES - 1;
      visible[last] = truncateToWidth(`${visible[last]}…`, width, "…");
    }
    return [
      ...visible,
      ...Array.from({ length: EXPANDED_ACTIVITY_LINES - visible.length }, () => ""),
    ];
  }

  invalidate(): void {}
}

class ExpandedSubagentResult extends Container {
  private readonly context = new Text("", 0, 0);
  private readonly usage = new Text("", 0, 0);
  private readonly activity = new ExpandedActivity();
  private readonly output = new Markdown("", 0, 0, getMarkdownTheme());
  private readonly status = new Text("", 0, 0);
  private readonly diagnostics = new Text("", 0, 0);
  private contextText = "";
  private usageText = "";
  private outputText = "";
  private statusText = "";
  private diagnosticsText = "";

  constructor() {
    super();
    this.addChild(this.context);
    this.addChild(this.usage);
    this.addChild(this.activity);
    this.addChild(new Spacer(1));
    this.addChild(this.output);
    this.addChild(this.status);
    this.addChild(this.diagnostics);
  }

  update(item: AgentResult, theme: RenderTheme): void {
    const working = !isComplete(item);
    const running = item.status === "running" || (item.status === undefined && working);
    const context = expandedContextLines(item, theme).join("\n");
    const usage = `${theme.fg("muted", "Usage: ")}${theme.fg("dim", formatUsage(item.usage) || "usage pending")}`;
    const output = working ? "" : finalOutput(item.messages);
    const error = working ? undefined : renderError(item, theme.fg.bind(theme));
    const status = error
      ? `${theme.fg("muted", "Error: ")}${error}`
      : working
        ? item.status === "queued"
          ? theme.fg("muted", "(waiting for subagent slot)")
          : theme.fg("muted", "(working…)")
        : output
          ? ""
          : theme.fg("muted", "(no output)");
    const diagnostics = working ? "" : diagnosticsLines(item, theme);

    this.contextText = updateText(this.context, this.contextText, context);
    this.usageText = updateText(this.usage, this.usageText, usage);
    this.activity.update(running, item.latestToolCall ? theme.fg("muted", `→ ${item.latestToolCall}`) : undefined);
    if (this.outputText !== output) {
      this.output.setText(output);
      this.outputText = output;
    }
    this.statusText = updateText(this.status, this.statusText, status);
    this.diagnosticsText = updateText(this.diagnostics, this.diagnosticsText, diagnostics);
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

function invalidateHeading(state: SubagentRowState, invalidate: () => void): void {
  if (state.headingRefreshPending) return;
  state.headingRefreshPending = true;
  queueMicrotask(() => {
    state.headingRefreshPending = false;
    invalidate();
  });
}

function syncHeadingState(
  state: SubagentRowState,
  item: AgentResult | undefined,
  isError: boolean,
  invalidate: () => void,
): void {
  if (item) state.result = item;
  const headingItem = item ?? state.result;
  const nextKey = [
    isError ? "error" : "ok",
    headingItem?.agent ?? "",
    headingItem?.model ?? "",
    headingItem?.thinking ?? "",
    headingItem?.status ?? "",
  ].join("\0");
  if (state.headingKey === nextKey) return;
  state.headingKey = nextKey;
  invalidateHeading(state, invalidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentResult(value: unknown): value is AgentResult {
  return isRecord(value)
    && typeof value.agent === "string"
    && typeof value.task === "string"
    && typeof value.cwd === "string"
    && typeof value.exitCode === "number"
    && Array.isArray(value.messages)
    && isRecord(value.usage);
}

/** Adapt only the old single-call shape; old batches remain raw display-only content. */
function parseDetails(value: unknown): AgentResult | undefined {
  if (!isRecord(value)) return undefined;
  if (isAgentResult(value.result)) return value.result;
  if (value.mode !== "single" || !Array.isArray(value.results)) return undefined;
  return (value as LegacySubagentDetails).results?.find(isAgentResult);
}

function queuedResult(params: SubagentParams, cwd: string): AgentResult {
  return {
    agent: params.agent,
    task: params.task,
    cwd: params.cwd ?? cwd,
    exitCode: -1,
    status: "queued",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(),
    model: params.model,
    thinking: params.thinking ?? thinkingFromModelReference(params.model),
  };
}

function makeDetails(result: AgentResult): SubagentDetails {
  return { result };
}

function normalizeContextWindow(result: AgentResult, contextWindow: number | undefined): AgentResult {
  if (contextWindow !== undefined && result.usage.contextWindow === undefined) {
    result.usage.contextWindow = contextWindow;
  }
  return result;
}

function resultUpdate(result: AgentResult, text: string): { content: [{ type: "text"; text: string }]; details: SubagentDetails } {
  return {
    content: [{ type: "text", text }],
    details: makeDetails(result),
  };
}

function emitResultUpdate(
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  result: AgentResult,
  text: string,
): void {
  onUpdate?.(resultUpdate(result, text));
}

function resultReturn(
  result: AgentResult,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): AgentToolResult<SubagentDetails> {
  const update = resultUpdate(result, truncateOutput(resultOutput(result)));
  onUpdate?.(update);
  return { ...update, usage: result.usage.usage };
}

function cancelledToolResult(
  request: Parameters<typeof abortedResult>[0],
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
): AgentToolResult<SubagentDetails> {
  return resultReturn(abortedResult(request), onUpdate);
}

function abortError(): Error {
  const error = new Error("Subagent execution was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface RefreshResult {
  aborted?: boolean;
}

interface RefreshFlight {
  controller: AbortController;
  promise: Promise<RefreshResult>;
  waiters: number;
}

function createModelRefresher() {
  let flight: RefreshFlight | undefined;

  return async function refreshModels(
    registry: { refresh(options: { signal: AbortSignal }): Promise<RefreshResult> },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();

    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => registry.refresh({ signal: controller.signal }));
      const created: RefreshFlight = { controller, promise, waiters: 0 };
      flight = created;
      void promise.then(() => {
        if (flight === created) flight = undefined;
      }, () => {
        if (flight === created) flight = undefined;
      });
    }

    const joined = flight!;
    joined.waiters++;
    try {
      const result = await waitForAbort(joined.promise, signal);
      if (result.aborted) throw new Error("Model refresh was aborted");
    } finally {
      joined.waiters--;
      if (joined.waiters === 0 && flight === joined) {
        flight = undefined;
        joined.controller.abort();
      }
    }
  };
}

function prepareArguments(raw: unknown): SubagentParams {
  if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "tasks")) {
    throw new Error(
      "The tasks syntax was removed; reissue each independent task as a sibling subagent call in the same response.",
    );
  }
  return raw as SubagentParams;
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}) {
  const run = options.run ?? runPiSubagent;

  return (pi: ExtensionAPI) => {
    if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

    const initialDiscovery = discoverAgents(options.agentsDirectory);
    const scheduler = new SubagentScheduler();
    const notifiedDiagnostics = new Set<string>();
    const refreshModels = createModelRefresher();

    const runChild = (request: RunRequest) => {
      const normalize = (result: AgentResult) => normalizeContextWindow(result, request.contextWindow);
      const update = request.onUpdate
        ? (result: AgentResult): void => request.onUpdate?.(normalize(result))
        : undefined;
      return run({
        ...request,
        environment: collectSubagentEnvironment(),
        onUpdate: update,
      }).then(normalize);
    };

    // Tool failures are returned with their retained details and usage so the
    // native Pi result can render them. Partial updates do not pass through
    // this finalized-result middleware.
    pi.on("tool_result", (event) => {
      if (event.toolName !== "subagent") return undefined;
      const result = parseDetails(event.details);
      if (!result || !isComplete(result)) return undefined;
      return resultFailed(result) ? { isError: true } : undefined;
    });

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate one task to one global agent in an isolated synchronous Pi process.",
        "Each invocation delegates exactly one task; cwd, model (Pi CLI syntax), and thinking override agent frontmatter and then the parent session when omitted.",
        `Available agents from ${initialDiscovery.directory}: ${formatAgentList(initialDiscovery.agents)}.`,
      ].join(" "),
      promptSnippet: "Delegate one task synchronously to an isolated global agent.",
      promptGuidelines: [
        "Issue all independent sibling subagent calls in the same response (maximum 8); do not issue unrelated sequential tools between them, then consume every complete synchronous result.",
      ],
      parameters: Parameters,
      prepareArguments,
      executionMode: "parallel",

      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as SubagentParams;
        if (!params.agent?.trim() || !params.task?.trim()) {
          throw new Error("agent and task are required and must be non-empty strings");
        }
        throwIfAborted(signal);

        const admission = scheduler.admit(signal);
        const initial = queuedResult(params, ctx.cwd);
        let resolved: RunRequest | undefined;
        try {
          emitResultUpdate(onUpdate, initial, "(waiting for subagent slot)");
          const discovery = discoverAgents(options.agentsDirectory);
          notifyDiagnostics(ctx, discovery.diagnostics, notifiedDiagnostics);
          const defaults = parentDefaults(ctx);
          await refreshModels(ctx.modelRegistry, signal);
          throwIfAborted(signal);
          const modelSnapshot = { current: ctx.model, available: ctx.modelRegistry.getAvailable() };
          const agent =
            discovery.agents.find((candidate) => candidate.name.toLowerCase() === params.agent.toLowerCase())
            ?? discovery.agents.find((candidate) => candidate.name === GENERAL_AGENT_NAME)!;
          const rawModel = params.model ?? agent.model;
          const requestedThinking = resolveThinking(params, agent, defaults.thinking);
          const modelResult = rawModel
            ? resolveModelReference(rawModel, modelSnapshot, requestedThinking)
            : { model: defaults.model, thinking: requestedThinking };
          resolved = {
            agent,
            task: params.task,
            cwd: params.cwd ?? ctx.cwd,
            model: modelResult.model,
            thinking: modelResult.thinking,
            contextWindow: contextWindowForModel(modelResult.model, modelSnapshot),
            signal,
          };

          const queued = {
            ...initial,
            agent: agent.name,
            cwd: resolved.cwd,
            model: resolved.model,
            thinking: resolved.thinking,
            usage: emptyTrackedUsage(resolved.contextWindow),
            status: "queued" as const,
          };
          emitResultUpdate(onUpdate, queued, "(waiting for subagent slot)");

          const lease = await admission.acquire();
          try {
            if (!lease || signal?.aborted) {
              return cancelledToolResult(resolved, onUpdate);
            }

            const running: AgentResult = {
              ...queued,
              status: "running",
              exitCode: -1,
            };
            emitResultUpdate(onUpdate, running, "(working…)");
            const result = await runChild({
              ...resolved,
              onUpdate: onUpdate
                ? (partial) => {
                    const runningPartial = { ...partial, status: "running" as const };
                    emitResultUpdate(onUpdate, runningPartial, truncateOutput(finalOutput(runningPartial.messages) || "(working…)"));
                  }
                : undefined,
            });
            if (!isComplete(result)) result.status = result.exitCode === 0 ? "done" : "failed";
            return resultReturn(result, onUpdate);
          } finally {
            // The lease is released even if cancellation wins after acquire()
            // resolves but before the runner continuation starts.
            lease?.release();
          }
        } catch (error) {
          if (signal?.aborted) {
            return cancelledToolResult(resolved ?? initial, onUpdate);
          }
          throw error;
        } finally {
          // close() removes an unlaunched waiter and releases the outstanding
          // admission. It is safe on every setup, cancellation, and runner path.
          admission.close();
        }
      },

      renderCall(args, theme, context) {
        const rawArgs = args as unknown as Record<string, unknown>;
        const state = context.state as SubagentRowState;
        const failed = context.isError;
        if (Object.prototype.hasOwnProperty.call(rawArgs, "tasks")) {
          const count = Array.isArray(rawArgs.tasks) ? rawArgs.tasks.length : "stored";
          const icon = failed ? theme.fg("error", "✗") : theme.fg("muted", "·");
          return retainedText(
            context.lastComponent,
            `${theme.fg("toolTitle", theme.bold("subagent"))} ${icon} ${theme.fg("muted", `legacy batch (${count})`)}`,
          );
        }

        const item = state.result;
        const icon = item
          ? agentIcon(item, theme.fg.bind(theme), failed)
          : failed ? theme.fg("error", "✗") : theme.fg("muted", "·");
        const agent = item?.agent ?? String(rawArgs.agent ?? "…");
        const metadata = modelThinkingSummary(item?.model ?? (typeof rawArgs.model === "string" ? rawArgs.model : undefined), item?.thinking ?? rawArgs.thinking as ModelThinkingLevel | undefined);
        // Keep state in the native row rather than creating a competing widget;
        // Ctrl+O and the standard Pi shell remain global.
        return retainedText(
          context.lastComponent,
          `${theme.fg("toolTitle", theme.bold("subagent"))} ${icon} ${theme.fg("toolTitle", theme.bold(agent))} ${theme.fg("dim", metadata)}`,
        );
      },

      renderResult(result, { expanded, isPartial }, theme, context) {
        const item = parseDetails(result.details);
        const state = context.state as SubagentRowState;
        syncHeadingState(state, item, context.isError, context.invalidate);
        const nativeError = context.isError;
        if (item) {
          const working = !nativeError && isWorking(item, isPartial);
          const displayItem = nativeError && (!isComplete(item) || !resultFailed(item))
            ? {
                ...item,
                exitCode: 1,
                status: "done" as const,
                errorMessage: result.content.find((part) => part.type === "text")?.text ?? "Subagent failed",
              }
            : item;
          if (!expanded) {
            const renderedError = renderError(displayItem, theme.fg.bind(theme));
            const latest = latestOutput(item.messages);
            const output = renderedError ?? (latest
              ? latestOutputPreview(latest, theme.fg.bind(theme))
              : theme.fg("muted", working
                ? item.status === "queued" ? "(waiting for subagent slot)" : "(working…)"
                : "(no output)"));
            return retainedText(context.lastComponent, [
              theme.fg("dim", formatUsage(item.usage) || "usage pending"),
              `${theme.fg("muted", "Prompt: ")}${theme.fg("dim", truncatedTask(item.task))}`,
              output,
            ].join("\n"));
          }

          const component = context.lastComponent instanceof ExpandedSubagentResult
            ? context.lastComponent
            : new ExpandedSubagentResult();
          component.update(displayItem, theme);
          return component;
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "(no output)";
        return retainedText(context.lastComponent, nativeError ? theme.fg("error", text) : text);
      },
    });
  };
}

export default createSubagentExtension();
