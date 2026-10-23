import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import type { ProcessHooks, RpcTransportOptions } from "./rpc.ts";

export const SUBAGENT_CHILD_ENV = "PI_EXTENSIONS_SUBAGENT_CHILD";
export const VIBE_WORKER_ENV = "PI_EXTENSIONS_SUBAGENT_VIBE_WORKER";

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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** Test seams: process timing, plus a Pi CLI entry and extra args (such as a fake provider). */
export interface LaunchHooks extends ProcessHooks {
  cliPath?: string;
  extraArgs?: string[];
}

export type LaunchSession =
  | { kind: "none" }
  | { kind: "new"; directory: string; id: string }
  | { kind: "resume"; file: string };

export interface LaunchRequest {
  agent: AgentConfig;
  cwd: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  environment?: Record<string, string>;
  session: LaunchSession;
  /** Extra system prompt text appended after the agent body. */
  appendPrompt?: string;
}

export interface Launch extends RpcTransportOptions {
  /** Remove the private prompt file. */
  cleanup(): Promise<void>;
}

/**
 * Build a `pi --mode rpc` invocation. The system prompt goes through a private
 * file that must exist before spawn: Pi appends a missing path as literal text.
 * The task itself is sent over stdin, never argv.
 */
export async function prepareLaunch(request: LaunchRequest, hooks: LaunchHooks = {}): Promise<Launch> {
  const { cliPath, extraArgs = [], ...processHooks } = hooks;
  const args = [...childExtensionArgs(), ...extraArgs, "--mode", "rpc"];
  if (request.model) args.push("--model", request.model);
  if (request.thinking) args.push("--thinking", request.thinking);
  if (request.agent.tools?.length) args.push("--tools", request.agent.tools.join(","));
  if (request.session.kind === "none") args.push("--no-session");
  else if (request.session.kind === "new") args.push("--session-dir", request.session.directory, "--session-id", request.session.id);
  else args.push("--session", request.session.file);

  let directory: string | undefined;
  const promptText = [request.agent.systemPrompt.trim(), request.appendPrompt?.trim()].filter(Boolean).join("\n\n");
  if (promptText) {
    directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
    const filePath = join(directory, `prompt-${request.agent.name.replace(/[^\w.-]+/g, "_")}.md`);
    try {
      await writeFile(filePath, promptText, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    args.push("--append-system-prompt", filePath);
  }

  const invocation = cliPath ? { command: process.execPath, args: [cliPath, ...args] } : getPiInvocation(args);
  return {
    ...processHooks,
    ...invocation,
    cwd: request.cwd,
    env: { ...process.env, ...request.environment, [SUBAGENT_CHILD_ENV]: "1" },
    cleanup: async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
