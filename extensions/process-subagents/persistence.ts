import * as fs from "node:fs";
import * as path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SNAPSHOT_TYPE,
  boundedPreview,
  isSnapshot,
  type PersistedRunSnapshot,
  type TerminalResult,
  type TokenUsage,
} from "./contracts.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface ChildSessionInspection {
  header: SessionHeader;
  entries: SessionEntry[];
  finalAssistant?: AssistantMessage;
  result?: string;
  terminal: boolean;
  failed: boolean;
  aborted: boolean;
  stopReason?: string;
  error?: string;
  usage?: TokenUsage;
  cost?: number;
}

export function createChildSession(
  cwd: string,
  sessionDir: string,
  childSessionId: string,
  parentSessionFile: string,
): { sessionId: string; sessionFile: string } {
  const manager = SessionManager.create(cwd, sessionDir, { id: childSessionId, parentSession: parentSessionFile });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi did not allocate a persisted child session path");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const sourceHeader = manager.getHeader();
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: manager.getSessionId(),
    timestamp: sourceHeader?.timestamp ?? new Date().toISOString(),
    cwd,
    parentSession: parentSessionFile,
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { sessionId: manager.getSessionId(), sessionFile: path.resolve(sessionFile) };
}

export function parseSessionFileStrict(filePath: string): FileEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read child session ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`Malformed child session ${filePath}: empty file`);
  const entries: FileEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) throw new Error(`Malformed child session ${filePath}: blank line ${index + 1}`);
    try {
      entries.push(JSON.parse(lines[index]) as FileEntry);
    } catch {
      throw new Error(`Malformed child session ${filePath}: invalid JSON on line ${index + 1}`);
    }
  }
  const header = entries[0] as Partial<SessionHeader>;
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string" || typeof header.cwd !== "string") {
    throw new Error(`Malformed child session ${filePath}: invalid session header`);
  }
  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index] as Partial<SessionEntry>;
    if (typeof entry.id !== "string" || !("parentId" in entry) || typeof entry.timestamp !== "string" || typeof entry.type !== "string") {
      throw new Error(`Malformed child session ${filePath}: invalid entry on line ${index + 1}`);
    }
  }
  return entries;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? "")).join("");
}

export function taskEnvelope(prompt: string): string {
  return `Delegated task (follow these instructions exactly):\n\n${prompt}`;
}

function entriesAfter(entries: SessionEntry[], cursor?: string): SessionEntry[] {
  if (!cursor) return entries;
  const index = entries.findIndex((entry) => entry.id === cursor);
  if (index < 0) throw new Error(`Child session cursor ${cursor} is missing`);
  return entries.slice(index + 1);
}

export function findDurableUserPrompt(filePath: string, expected: string, cursor?: string): string | undefined {
  const entries = entriesAfter(parseSessionFileStrict(filePath).slice(1) as SessionEntry[], cursor);
  return entries.find((entry) => entry.type === "message" && entry.message.role === "user" && contentText(entry.message.content) === expected)?.id;
}

export function hasDurableUserPrompt(filePath: string, expected: string, cursor?: string): boolean {
  return Boolean(findDurableUserPrompt(filePath, expected, cursor));
}

export function inspectChildSession(filePath: string, afterEntryId?: string): ChildSessionInspection {
  const fileEntries = parseSessionFileStrict(filePath);
  const header = fileEntries[0] as SessionHeader;
  const entries = fileEntries.slice(1) as SessionEntry[];
  const allAssistants: AssistantMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") allAssistants.push(entry.message as AssistantMessage);
  }
  const currentEntries = entriesAfter(entries, afterEntryId);
  const currentAssistants: AssistantMessage[] = [];
  for (const entry of currentEntries) {
    if (entry.type === "message" && entry.message.role === "assistant") currentAssistants.push(entry.message as AssistantMessage);
  }
  const finalAssistant = currentAssistants.at(-1);
  const result = finalAssistant ? contentText(finalAssistant.content) : undefined;
  const failed = finalAssistant?.stopReason === "error" || Boolean(finalAssistant?.errorMessage);
  const aborted = finalAssistant?.stopReason === "aborted";
  const terminal = Boolean(finalAssistant && finalAssistant.stopReason && finalAssistant.stopReason !== "toolUse");
  const usage = allAssistants.reduce<TokenUsage>((total, message) => ({
    input: total.input + (message.usage?.input ?? 0),
    output: total.output + (message.usage?.output ?? 0),
    cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (message.usage?.cacheWrite ?? 0),
    total: total.total + (message.usage?.totalTokens ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const cost = allAssistants.reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0);
  return {
    header,
    entries,
    finalAssistant,
    result,
    terminal,
    failed,
    aborted,
    stopReason: finalAssistant?.stopReason,
    error: finalAssistant?.errorMessage,
    usage: allAssistants.length ? usage : undefined,
    cost: allAssistants.length ? cost : undefined,
  };
}

export function inspectSnapshotChildSession(snapshot: PersistedRunSnapshot): ChildSessionInspection {
  if (!snapshot.childSessionFile) throw new Error("Child session path is missing");
  const inspection = inspectChildSession(snapshot.childSessionFile, snapshot.acceptedPromptEntryId);
  if (inspection.header.id !== snapshot.childSessionId || inspection.header.cwd !== snapshot.cwd ||
      inspection.header.parentSession !== snapshot.parentSessionFile) {
    throw new Error("Child session header does not match the recorded child ID, cwd, or parent session");
  }
  return inspection;
}

export function locateToolOrigin(manager: ReadonlySessionManager, toolCallId: string): string {
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    if (entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) return entry.id;
  }
  throw new Error("Cannot locate this tool call on the active parent branch; no child was started");
}

export function branchContains(manager: ReadonlySessionManager, originEntryId: string, fromId?: string): boolean {
  return manager.getBranch(fromId).some((entry) => entry.id === originEntryId);
}

export function appendSnapshotIfVisible(
  pi: ExtensionAPI,
  manager: ReadonlySessionManager,
  snapshot: PersistedRunSnapshot,
): boolean {
  if (!branchContains(manager, snapshot.runOriginEntryId)) return false;
  pi.appendEntry(SNAPSHOT_TYPE, snapshot);
  return true;
}

export function loadVisibleSnapshots(manager: ReadonlySessionManager): Map<string, PersistedRunSnapshot> {
  const result = new Map<string, PersistedRunSnapshot>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE || !isSnapshot(entry.data)) continue;
    result.set(`${entry.data.agentId}:${entry.data.runId}`, entry.data);
  }
  return result;
}

export function toTerminalResult(snapshot: PersistedRunSnapshot, fullResult?: string): TerminalResult {
  if (snapshot.status === "starting" || snapshot.status === "running") {
    throw new Error(`Agent ${snapshot.agentId} is still ${snapshot.status}`);
  }
  return {
    agentId: snapshot.agentId,
    runId: snapshot.runId,
    status: snapshot.status,
    childSessionId: snapshot.childSessionId,
    childSessionFile: snapshot.childSessionFile,
    result: fullResult ?? snapshot.resultPreview,
    stopReason: snapshot.stopReason,
    error: snapshot.error,
    usage: snapshot.usage,
    cost: snapshot.cost,
    contextUsage: snapshot.contextUsage,
  };
}

export function terminalSnapshotFromInspection(
  snapshot: PersistedRunSnapshot,
  inspection: ChildSessionInspection,
  fallbackStatus: "interrupted" | "failed" = "interrupted",
): PersistedRunSnapshot {
  const status = snapshot.acceptedPromptEntryId && inspection.terminal && !inspection.aborted
    ? (inspection.failed ? "failed" : "completed") : fallbackStatus;
  return {
    ...snapshot,
    status,
    completedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    resultPreview: boundedPreview(inspection.result),
    stopReason: inspection.stopReason,
    error: inspection.error ?? (status === "interrupted" ? "Child process is no longer owned by this session" : snapshot.error),
    usage: inspection.usage,
    cost: inspection.cost,
    notificationPending: snapshot.background && !snapshot.resultConsumed,
  };
}
