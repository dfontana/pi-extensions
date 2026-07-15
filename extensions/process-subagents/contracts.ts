import type { ContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";

export const SNAPSHOT_TYPE = "process-subagents:v1";
export const CHILD_MANIFEST_TYPE = "process-subagents:child-manifest:v1";
export const CHILD_MANIFEST_COMMAND = "__process_subagent_manifest";
export const CHILD_MARKER = "PI_PROCESS_SUBAGENT_CHILD";
export const DELEGATION_TOOLS = new Set([
  "Agent",
  "get_subagent_result",
  "resume_subagent",
  "stop_subagent",
  "steer_subagent",
]);

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const TERMINAL_STATUSES = ["completed", "failed", "aborted", "interrupted"] as const;
export type AgentStatus = "starting" | "running" | (typeof TERMINAL_STATUSES)[number];

export interface AgentInput {
  prompt: string;
  description: string;
  subagent_type: string;
  model?: string;
  thinking?: ThinkingLevel;
  run_in_background?: boolean;
}

export interface ResumeSubagentInput {
  agent_id: string;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  run_in_background?: boolean;
}

export interface SubagentConfig {
  maxConcurrentAgents: number;
  idleWarningMs: number;
  widgetMaxRows: number;
  defaultBackground: boolean;
  modelAliases: Record<string, string>;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrentAgents: 4,
  idleWarningMs: 120_000,
  widgetMaxRows: 4,
  defaultBackground: false,
  modelAliases: {},
};

export interface AgentDefinition {
  id: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  runInBackground?: boolean;
  source: "builtin" | "user" | "project";
  filePath?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PersistedRunSnapshot {
  version: 1;
  agentId: string;
  runId: string;
  runNumber: number;
  agentOriginEntryId: string;
  runOriginEntryId: string;
  parentSessionId: string;
  parentSessionFile: string;
  childSessionId: string;
  childSessionFile?: string;
  childEntryCursor?: string;
  acceptedPromptEntryId?: string;
  type: string;
  displayName: string;
  description: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  tools: string[];
  modelRequest: { reference?: string; source: "call" | "definition" | "parent" | "resume" };
  resolvedModel: { provider: string; id: string };
  thinking: ThinkingLevel;
  background: boolean;
  status: AgentStatus;
  startedAt: string;
  completedAt?: string;
  lastActivityAt?: string;
  resultConsumed: boolean;
  notificationPending: boolean;
  notificationSent: boolean;
  resultPreview?: string;
  stopReason?: string;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
  contextUsage?: ContextUsage;
}

export interface ChildManifest {
  version: 1;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  trusted: boolean;
  model?: { provider: string; id: string };
  thinking: ThinkingLevel;
  tools: string[];
}

export interface TerminalResult {
  agentId: string;
  runId: string;
  status: "completed" | "failed" | "aborted" | "interrupted";
  childSessionId: string;
  childSessionFile?: string;
  result?: string;
  stopReason?: string;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
  contextUsage?: ContextUsage;
}

export interface BackgroundAcceptance {
  agentId: string;
  runId: string;
  childSessionId: string;
  childSessionFile: string;
  status: "running";
}

export function isTerminalStatus(status: AgentStatus): status is TerminalResult["status"] {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function usageFromStats(stats: SessionStats): TokenUsage {
  return { ...stats.tokens };
}

export function boundedPreview(text: string | undefined, max = 4000): string | undefined {
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

export function publicError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[redacted]")
    .replace(/:\/\/[^/@\s:]+:[^/@\s]+@/g, "://[redacted]@");
}

export function isSnapshot(value: unknown): value is PersistedRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const strings = ["agentId", "runId", "agentOriginEntryId", "runOriginEntryId", "parentSessionId",
    "parentSessionFile", "childSessionId", "type", "displayName", "description", "prompt", "systemPrompt", "cwd", "startedAt"];
  if (v.version !== 1 || !strings.every((field) => typeof v[field] === "string" && v[field] !== "") ||
      !Number.isInteger(v.runNumber) || (v.runNumber as number) < 1 ||
      !Array.isArray(v.tools) || v.tools.some((tool) => typeof tool !== "string") ||
      !["starting", "running", ...TERMINAL_STATUSES].includes(v.status as AgentStatus) ||
      !(THINKING_LEVELS as readonly unknown[]).includes(v.thinking) || typeof v.background !== "boolean" ||
      typeof v.resultConsumed !== "boolean" || typeof v.notificationPending !== "boolean" ||
      typeof v.notificationSent !== "boolean") return false;
  const request = v.modelRequest as Record<string, unknown> | undefined;
  const resolved = v.resolvedModel as Record<string, unknown> | undefined;
  if (!request || !["call", "definition", "parent", "resume"].includes(String(request.source)) ||
      (request.reference !== undefined && typeof request.reference !== "string") ||
      !resolved || typeof resolved.provider !== "string" || !resolved.provider || typeof resolved.id !== "string" || !resolved.id) return false;
  for (const field of ["childSessionFile", "childEntryCursor", "acceptedPromptEntryId", "completedAt", "lastActivityAt",
    "resultPreview", "stopReason", "error"] as const) {
    if (v[field] !== undefined && typeof v[field] !== "string") return false;
  }
  if (v.cost !== undefined && (typeof v.cost !== "number" || !Number.isFinite(v.cost))) return false;
  if (v.usage !== undefined) {
    const usage = v.usage as Record<string, unknown>;
    if (!usage || typeof usage !== "object" || !["input", "output", "cacheRead", "cacheWrite", "total"]
      .every((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]))) return false;
  }
  if (v.contextUsage !== undefined) {
    const context = v.contextUsage as Record<string, unknown>;
    if (!context || typeof context !== "object" ||
        !(context.tokens === null || typeof context.tokens === "number") || typeof context.contextWindow !== "number" ||
        !(context.percent === null || typeof context.percent === "number")) return false;
  }
  return true;
}
