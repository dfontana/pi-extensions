import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { thinkingFromModelReference } from "../model-query/query.ts";
import type { RpcExit } from "./rpc.ts";
import { textOf, truncateUtf8 } from "./text.ts";
import { emptyTrackedUsage, type TrackedUsage } from "./usage.ts";

export const MAX_CAPTURED_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CAPTURED_MESSAGE_BYTES = 512 * 1024;
const MAX_TOOL_CALL_PREVIEW_BYTES = 64 * 1024;

export interface RunRequest {
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  /** Context window of the resolved model, used for compact usage display. */
  contextWindow?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  onUpdate?: (result: AgentResult) => void;
}

export type SubagentStatus = "queued" | "running" | "done" | "aborted" | "failed" | "spawn-error";

export type SubagentTermination = Omit<RpcExit, "spawnError">;

export interface SubagentProcessDiagnostics {
  pid?: number;
  durationMs?: number;
  termination?: SubagentTermination;
  spawnError?: string;
  stdoutTail?: string;
  protocolErrors?: number;
}

export interface AgentResult {
  agent: string;
  task: string;
  cwd: string;
  exitCode: number;
  status?: SubagentStatus;
  messages: Message[];
  stderr: string;
  usage: TrackedUsage;
  model?: string;
  thinking?: ModelThinkingLevel;
  stopReason?: string;
  errorMessage?: string;
  /** Most recent tool activity, retained for the expanded running view. */
  latestToolCall?: string;
  /** Process-level diagnostics, attached only when the run fails. */
  process?: SubagentProcessDiagnostics;
}

export type SubagentRunner = (request: RunRequest) => Promise<AgentResult>;

export interface ResultIdentity {
  agent: AgentConfig | string;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  contextWindow?: number;
}

/** A running result for `identity`; the thinking level falls back to a model `:suffix`. */
export function newResult(identity: ResultIdentity, overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agent: typeof identity.agent === "string" ? identity.agent : identity.agent.name,
    task: identity.task,
    cwd: identity.cwd,
    exitCode: -1,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(identity.contextWindow),
    model: identity.model,
    thinking: identity.thinking ?? thinkingFromModelReference(identity.model),
    ...overrides,
  };
}

/** The canonical result for a call cancelled before or during launch. */
export function abortedResult(identity: ResultIdentity): AgentResult {
  return newResult(identity, { exitCode: 130, status: "aborted", stopReason: "aborted", errorMessage: "Subagent was aborted" });
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const preview = `${name} ${JSON.stringify(args, null, 2) ?? "{}"}`;
  // Rendering clips this to ten terminal lines. Keep a generous storage bound
  // as defense against exceptionally large write/edit arguments.
  return truncateUtf8(preview, MAX_TOOL_CALL_PREVIEW_BYTES);
}

export function captureToolCalls(result: AgentResult, message: Message): void {
  if (message.role !== "assistant") return;
  for (const part of message.content) {
    if (part.type === "toolCall") result.latestToolCall = formatToolCall(part.name, part.arguments);
  }
}

export function finalOutput(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") return textOf(messages[index].content, "\n").trim();
  }
  return "";
}

export function resultFailed(result: AgentResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function resultOutput(result: AgentResult): string {
  if (!resultFailed(result)) return finalOutput(result.messages) || "(no output)";
  return result.errorMessage
    || result.stderr.trim()
    || finalOutput(result.messages)
    || processSummary(result)
    || "(no output)";
}

function processSummary(result: AgentResult): string {
  const proc = result.process;
  if (!proc) return "";
  const term = proc.termination;
  let lead: string;
  if (proc.spawnError) lead = `Subagent process failed to spawn: ${proc.spawnError}`;
  else if (result.status === "aborted") lead = "Subagent process was aborted before producing a Pi response";
  else if (term?.signal) lead = `Subagent process was terminated by ${term.signal} before producing a Pi response`;
  else if (term?.exitCode !== undefined && term.exitCode !== null) lead = `Subagent process exited with code ${term.exitCode} before producing a Pi response`;
  else lead = "Subagent process ended before producing a Pi response";
  const detail: string[] = [`${result.messages.length} message${result.messages.length === 1 ? "" : "s"}`];
  if (proc.durationMs !== undefined) detail.push(`${proc.durationMs} ms`);
  if (proc.protocolErrors) detail.push(`${proc.protocolErrors} protocol error${proc.protocolErrors === 1 ? "" : "s"}`);
  if (proc.stdoutTail) detail.push(`${Buffer.byteLength(proc.stdoutTail, "utf8")} bytes unparsed stdout`);
  return `${lead} (${detail.join(", ")}).`;
}

export function capMessage(message: Message): Message {
  if (Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_CAPTURED_MESSAGE_BYTES) return message;
  const cap = (text: string, fallback: string) => truncateUtf8(text || fallback, MAX_CAPTURED_MESSAGE_BYTES / 2);
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: cap(textOf(message.content, "\n"), "[oversized assistant message omitted]") }],
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      usage: message.usage,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: cap(textOf(message.content, "\n"), "[oversized tool result omitted]") }],
      usage: message.usage,
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return { ...message, content: cap(typeof message.content === "string" ? message.content : "", "[oversized user message omitted]") };
}
