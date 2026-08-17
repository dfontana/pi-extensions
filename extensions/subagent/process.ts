import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { thinkingFromModelReference } from "../model-query/query.ts";
import { emptyTrackedUsage, trackMessageUsage, type TrackedUsage } from "./usage.ts";

export const SUBAGENT_CHILD_ENV = "PI_EXTENSIONS_SUBAGENT_CHILD";
const MAX_CAPTURED_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CAPTURED_MESSAGE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TOOL_CALL_PREVIEW_BYTES = 64 * 1024;
const MAX_STDOUT_TAIL_BYTES = 16 * 1024;
const MAX_STDOUT_LINE_BYTES = MAX_CAPTURED_TRANSCRIPT_BYTES;

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

export interface SubagentTermination {
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  escalatedToSigkill?: boolean;
}

export interface SubagentProcessDiagnostics {
  pid?: number;
  durationMs?: number;
  termination?: SubagentTermination;
  spawnError?: string;
  stdoutTail?: string;
  stdoutBytesIgnored?: number;
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

export function childProcessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, [SUBAGENT_CHILD_ENV]: "1" };
}

/** Preserve explicit extension loading while making relative paths child-cwd safe. */
export function childExtensionArgs(
  argv: readonly string[] = process.argv.slice(2),
  parentCwd = process.cwd(),
): string[] {
  const inherited: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-extensions" || arg === "-ne") inherited.push("--no-extensions");
    else if ((arg === "--extension" || arg === "-e") && argv[index + 1]) {
      inherited.push("--extension", resolve(parentCwd, argv[++index]));
    }
  }
  return inherited;
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
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let truncated = value.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return `${truncated}\n[truncated]`;
}

function utf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Buffer.byteLength(value.slice(mid), "utf8") > maxBytes) lo = mid + 1;
    else hi = mid;
  }
  return value.slice(lo);
}

function capMessage(message: Message): Message {
  if (Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_CAPTURED_MESSAGE_BYTES) return message;
  if (message.role === "assistant") {
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return {
      role: "assistant",
      content: [{ type: "text", text: truncateUtf8(text || "[oversized assistant message omitted]", MAX_CAPTURED_MESSAGE_BYTES / 2) }],
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
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: truncateUtf8(text || "[oversized tool result omitted]", MAX_CAPTURED_MESSAGE_BYTES / 2) }],
      usage: message.usage,
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return { ...message, content: truncateUtf8(typeof message.content === "string" ? message.content : "[oversized user message omitted]", MAX_CAPTURED_MESSAGE_BYTES / 2) };
}

export interface AbortedResultRequest {
  agent: AgentConfig | string;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  contextWindow?: number;
}

/** Build the canonical result for a call cancelled before or during launch. */
export function abortedResult(request: AbortedResultRequest): AgentResult {
  return {
    agent: typeof request.agent === "string" ? request.agent : request.agent.name,
    task: request.task,
    cwd: request.cwd,
    exitCode: 130,
    status: "aborted",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(request.contextWindow),
    model: request.model,
    thinking: request.thinking ?? thinkingFromModelReference(request.model),
    stopReason: "aborted",
    errorMessage: "Subagent was aborted",
  };
}

interface SystemPromptFile {
  directory: string;
  filePath: string;
}

interface TaskFile {
  directory: string;
  filePath: string;
}

async function writeTaskFile(task: string): Promise<TaskFile> {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-task-"));
  const filePath = join(directory, "task.md");
  try {
    await writeFile(filePath, task, { encoding: "utf8", mode: 0o600 });
    return { directory, filePath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Test-only launch seams; normal callers use the one-argument runner. */
export interface RunPiSubagentHooks {
  afterPromptCreation?: (prompt: SystemPromptFile | undefined) => void | Promise<void>;
  spawn?: typeof spawn;
  /** Test-only override for the TERM→KILL escalation delay. */
  escalationDelayMs?: number;
}

async function writeSystemPrompt(
  agent: AgentConfig,
  afterCreation?: RunPiSubagentHooks["afterPromptCreation"],
): Promise<SystemPromptFile | undefined> {
  if (!agent.systemPrompt.trim()) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  try {
    const safeName = agent.name.replace(/[^\w.-]+/g, "_");
    const filePath = join(directory, `prompt-${safeName}.md`);
    const prompt = { directory, filePath };
    await writeFile(filePath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
    await afterCreation?.(prompt);
    return prompt;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runPiSubagent(request: RunRequest, hooks: RunPiSubagentHooks = {}): Promise<AgentResult> {
  const result: AgentResult = {
    agent: request.agent.name,
    task: request.task,
    cwd: request.cwd,
    exitCode: -1,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(request.contextWindow),
    model: request.model,
    thinking: request.thinking ?? thinkingFromModelReference(request.model),
  };
  if (request.signal?.aborted) return abortedResult(request);

  const args = [...childExtensionArgs(), "--mode", "json", "-p", "--no-session"];
  if (request.model) args.push("--model", request.model);
  if (request.thinking) args.push("--thinking", request.thinking);
  if (request.agent.tools?.length) args.push("--tools", request.agent.tools.join(","));

  let prompt: SystemPromptFile | undefined;
  let taskFile: TaskFile | undefined;
  try {
    prompt = await writeSystemPrompt(request.agent, hooks.afterPromptCreation);
    if (request.signal?.aborted) return abortedResult(request);
    if (prompt) args.push("--append-system-prompt", prompt.filePath);
    taskFile = await writeTaskFile(`Task: ${request.task}`);
    if (request.signal?.aborted) return abortedResult(request);
    args.push(`@${taskFile.filePath}`);

    const invocation = getPiInvocation(args);
    if (request.signal?.aborted) return abortedResult(request);
    let aborted = false;

    result.exitCode = await new Promise<number>((resolve) => {
      const startedAt = Date.now();
      const child = (hooks.spawn ?? spawn)(invocation.command, invocation.args, {
        cwd: request.cwd,
        env: childProcessEnvironment(request.environment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      let stdoutLine = "";
      let stdoutLineBytes = 0;
      let discardingStdoutLine = false;
      let capturedBytes = 0;
      let stdoutTail = "";
      let stdoutTailTotal = 0;
      let protocolErrors = 0;
      let spawnError: string | undefined;
      let escalatedToSigkill = false;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;

      const captureStdoutTail = (chunk: string) => {
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        if (!chunkBytes) return;
        stdoutTailTotal += chunkBytes;
        stdoutTail = chunkBytes >= MAX_STDOUT_TAIL_BYTES
          ? utf8Tail(chunk, MAX_STDOUT_TAIL_BYTES)
          : utf8Tail(stdoutTail + chunk, MAX_STDOUT_TAIL_BYTES);
      };

      const processLine = (line: string, terminator: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: Message };
        try {
          event = JSON.parse(line) as { type?: string; message?: Message };
        } catch {
          captureStdoutTail(line + terminator);
          protocolErrors++;
          return;
        }
        if (!event.message || (event.type !== "message_end" && event.type !== "tool_result_end")) {
          captureStdoutTail(line + terminator);
          return;
        }

        captureToolCalls(result, event.message);
        const captured = capMessage(event.message);
        const messageBytes = Buffer.byteLength(JSON.stringify(captured), "utf8");
        while (result.messages.length && capturedBytes + messageBytes > MAX_CAPTURED_TRANSCRIPT_BYTES) {
          capturedBytes -= Buffer.byteLength(JSON.stringify(result.messages.shift()), "utf8");
        }
        result.messages.push(captured);
        capturedBytes += messageBytes;
        trackMessageUsage(result.usage, event.message);
        if (event.message.role === "assistant") {
          result.model = `${event.message.provider}/${event.message.responseModel ?? event.message.model}`;
          result.stopReason = event.message.stopReason;
          result.errorMessage = event.message.errorMessage;
        }
        // Bounded tool-result bodies are retained for accounting/debug details but
        // are not visible in the subagent renderer. Only assistant messages can
        // add a visible tool call or response, so avoid repainting invisible events.
        if (event.message.role === "assistant") request.onUpdate?.(result);
      };

      const appendStdoutSegment = (segment: string) => {
        if (discardingStdoutLine) {
          captureStdoutTail(segment);
          return;
        }
        const segmentBytes = Buffer.byteLength(segment, "utf8");
        if (stdoutLineBytes + segmentBytes <= MAX_STDOUT_LINE_BYTES) {
          stdoutLine += segment;
          stdoutLineBytes += segmentBytes;
          return;
        }
        protocolErrors++;
        discardingStdoutLine = true;
        captureStdoutTail(stdoutLine);
        captureStdoutTail(segment);
        stdoutLine = "";
        stdoutLineBytes = 0;
      };

      const consumeStdout = (chunk: string) => {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf("\n", offset);
          if (newline === -1) {
            appendStdoutSegment(chunk.slice(offset));
            return;
          }
          appendStdoutSegment(chunk.slice(offset, newline));
          if (discardingStdoutLine) captureStdoutTail("\n");
          else processLine(stdoutLine, "\n");
          stdoutLine = "";
          stdoutLineBytes = 0;
          discardingStdoutLine = false;
          offset = newline + 1;
        }
      };

      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            escalatedToSigkill = true;
            child.kill("SIGKILL");
          }
        }, hooks.escalationDelayMs ?? 5_000);
        killTimer.unref();
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", abort);
        if (!discardingStdoutLine && stdoutLine.trim()) processLine(stdoutLine, "");
        const termination: SubagentTermination = {};
        if (code !== null) termination.exitCode = code;
        if (signal) termination.signal = signal;
        if (escalatedToSigkill) termination.escalatedToSigkill = true;
        let status: SubagentStatus;
        if (aborted) {
          status = "aborted";
          result.stopReason = "aborted";
        } else if (spawnError) {
          status = "spawn-error";
        } else if (code === 0) {
          status = "done";
        } else {
          status = "failed";
        }
        if (status !== "done") {
          result.process = {
            pid,
            durationMs: Date.now() - startedAt,
            termination: Object.keys(termination).length ? termination : undefined,
            spawnError,
            stdoutTail: stdoutTail || undefined,
            stdoutBytesIgnored: (stdoutTailTotal - Buffer.byteLength(stdoutTail, "utf8")) || undefined,
            protocolErrors: protocolErrors || undefined,
          };
        }
        result.status = status;
        resolve(aborted ? 130 : (code ?? 1));
      };

      child.stdout.on("data", (chunk) => consumeStdout(chunk.toString()));
      child.stderr.on("data", (chunk) => {
        result.stderr += chunk.toString();
        if (Buffer.byteLength(result.stderr, "utf8") > MAX_STDERR_BYTES) {
          result.stderr = `[earlier stderr truncated]\n${truncateUtf8(result.stderr.slice(-MAX_STDERR_BYTES), MAX_STDERR_BYTES)}`;
        }
      });
      child.on("error", (error) => {
        if (aborted) result.stderr += `${result.stderr ? "\n" : ""}${error.message}`;
        else spawnError = error.message;
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));

      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
    });

    return result;
  } finally {
    if (taskFile) await rm(taskFile.directory, { recursive: true, force: true });
    if (prompt) await rm(prompt.directory, { recursive: true, force: true });
  }
};
