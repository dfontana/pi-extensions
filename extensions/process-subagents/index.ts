import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_MARKER } from "./contracts.ts";
import { SubagentRuntime } from "./runtime.ts";
import { registerSubagentTools } from "./tools.ts";
import { installSubagentUi, showAgents } from "./viewer.ts";

function versionAtLeast(actual: string, minimum: [number, number, number]): boolean {
  const parts = actual.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

export default function processSubagents(pi: ExtensionAPI) {
  if (process.env[CHILD_MARKER] === "1") return;
  if (!versionAtLeast(VERSION, [0, 80, 6])) {
    throw new Error(`process-subagents requires Pi 0.80.6 or newer (found ${VERSION})`);
  }

  const runtime = new SubagentRuntime(pi);
  registerSubagentTools(pi, runtime);

  pi.registerCommand("agents", {
    description: "View branch-visible subagent transcripts",
    handler: async (_args, ctx) => showAgents(runtime, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime.sessionStart(ctx);
    installSubagentUi(runtime, ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const message = runtime.deliverPending(ctx);
    return message ? { message } : undefined;
  });
  pi.on("session_before_tree", async (event, ctx) => {
    await runtime.beforeTree(event.preparation.targetId, ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    runtime.reconcileDirty(ctx);
  });
  pi.on("session_shutdown", async (event) => {
    await runtime.shutdown(event.reason);
  });
}
