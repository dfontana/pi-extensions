import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { emptyTrackedUsage, trackMessageUsage, type TrackedUsage } from "./usage.ts";

export const SUBAGENT_CHILD_ENV = "PI_EXTENSIONS_SUBAGENT_CHILD";
const MAX_CAPTURED_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CAPTURED_MESSAGE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CAPTURED_TOOL_CALLS = 200;
const MAX_TOOL_CALL_SUMMARY_LENGTH = 500;

export interface RunRequest {
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  signal?: AbortSignal;
  onUpdate?: (result: AgentResult) => void;
}

export interface AgentResult {
  agent: string;
  task: string;
  cwd: string;
  exitCode: number;
  status?: "queued" | "running" | "done";
  messages: Message[];
  stderr: string;
  usage: TrackedUsage;
  model?: string;
  thinking?: ModelThinkingLevel;
  stopReason?: string;
  errorMessage?: string;
  toolCalls?: string[];
  omittedToolCalls?: number;
}

export type SubagentRunner = (request: RunRequest) => Promise<AgentResult>;

function shortenPath(value: string): string {
  const home = homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? args.file_path ?? "...");
  let summary: string;
  switch (name) {
    case "bash": {
      const command = String(args.command ?? "...");
      summary = `$ ${command.length > 70 ? `${command.slice(0, 70)}…` : command}`;
      break;
    }
    case "read":
    case "write":
    case "edit":
    case "ls":
      summary = `${name} ${shortenPath(path)}`;
      break;
    case "find":
      summary = `find ${String(args.pattern ?? "*")} in ${shortenPath(path)}`;
      break;
    case "grep":
      summary = `grep /${String(args.pattern ?? "")}/ in ${shortenPath(path)}`;
      break;
    default: {
      const encoded = JSON.stringify(args);
      summary = `${name} ${encoded.length > 60 ? `${encoded.slice(0, 60)}…` : encoded}`;
    }
  }
  return summary.length > MAX_TOOL_CALL_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_TOOL_CALL_SUMMARY_LENGTH - 1)}…`
    : summary;
}

export function captureToolCalls(result: AgentResult, message: Message): void {
  if (message.role !== "assistant") return;
  result.toolCalls ??= [];
  for (const part of message.content) {
    if (part.type !== "toolCall") continue;
    if (result.toolCalls.length < MAX_CAPTURED_TOOL_CALLS) {
      result.toolCalls.push(formatToolCall(part.name, part.arguments));
    } else {
      result.omittedToolCalls = (result.omittedToolCalls ?? 0) + 1;
    }
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
  if (resultFailed(result)) return result.errorMessage || result.stderr.trim() || finalOutput(result.messages) || "(no output)";
  return finalOutput(result.messages) || "(no output)";
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

function thinkingFromModelReference(model: string | undefined): ModelThinkingLevel | undefined {
  const match = model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  return match?.[1] as ModelThinkingLevel | undefined;
}

async function writeSystemPrompt(agent: AgentConfig): Promise<{ directory: string; filePath: string } | undefined> {
  if (!agent.systemPrompt.trim()) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const safeName = agent.name.replace(/[^\w.-]+/g, "_");
  const filePath = join(directory, `prompt-${safeName}.md`);
  await writeFile(filePath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { directory, filePath };
}

export const runPiSubagent: SubagentRunner = async (request) => {
  const result: AgentResult = {
    agent: request.agent.name,
    task: request.task,
    cwd: request.cwd,
    exitCode: -1,
    status: "running",
    messages: [],
    stderr: "",
    usage: emptyTrackedUsage(),
    model: request.model,
    thinking: request.thinking ?? thinkingFromModelReference(request.model),
    toolCalls: [],
  };
  if (request.signal?.aborted) {
    result.exitCode = 130;
    result.status = "done";
    result.stopReason = "aborted";
    result.errorMessage = "Subagent was aborted";
    return result;
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  if (request.model) args.push("--model", request.model);
  if (request.thinking) args.push("--thinking", request.thinking);
  if (request.agent.tools?.length) args.push("--tools", request.agent.tools.join(","));

  const prompt = await writeSystemPrompt(request.agent);
  if (prompt) args.push("--append-system-prompt", prompt.filePath);
  args.push(`Task: ${request.task}`);

  try {
    const invocation = getPiInvocation(args);
    let aborted = false;

    result.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: request.cwd,
        env: { ...process.env, [SUBAGENT_CHILD_ENV]: "1" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let capturedBytes = 0;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", abort);
        resolve(code);
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: Message };
        try {
          event = JSON.parse(line) as { type?: string; message?: Message };
        } catch {
          return;
        }
        if (!event.message || (event.type !== "message_end" && event.type !== "tool_result_end")) return;

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
        // Tool-result bodies are retained for accounting/debug details but are not
        // visible in the subagent renderer. Only assistant messages can add a
        // visible tool call or response, so avoid repainting for invisible events.
        if (event.message.role === "assistant") request.onUpdate?.(result);
      };

      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
        killTimer.unref();
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk) => {
        result.stderr += chunk.toString();
        if (Buffer.byteLength(result.stderr, "utf8") > MAX_STDERR_BYTES) {
          result.stderr = `[earlier stderr truncated]\n${truncateUtf8(result.stderr.slice(-MAX_STDERR_BYTES), MAX_STDERR_BYTES)}`;
        }
      });
      child.on("error", (error) => {
        result.stderr += `${result.stderr ? "\n" : ""}${error.message}`;
        settle(1);
      });
      child.on("close", (code) => {
        if (stdout.trim()) processLine(stdout);
        if (aborted) {
          result.stopReason = "aborted";
          result.errorMessage ||= "Subagent was aborted";
        }
        settle(code ?? (aborted ? 130 : 1));
      });

      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
    });

    result.status = "done";
    return result;
  } finally {
    if (prompt) await rm(prompt.directory, { recursive: true, force: true });
  }
};
