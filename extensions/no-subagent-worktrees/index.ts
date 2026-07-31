import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type AgentToolInput = {
  isolation?: unknown;
};

const WORKTREE_POLICY = [
  "## Subagent worktree policy",
  "Never include `isolation` in an `Agent` tool call. Worktree isolation is disabled locally; subagents must use the current checkout.",
  "`isolated: true` is allowed and only restricts a subagent's tools—it does not create a worktree.",
  "Do not retry an Agent call with `isolation: \"worktree\"`.",
].join("\n");

/**
 * Temporary guard against pi-subagents worktree isolation.
 *
 * Remove this extension once the upstream fix is available:
 * https://github.com/tintinweb/pi-subagents/issues/184
 */
export default function noSubagentWorktrees(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${WORKTREE_POLICY}`,
  }));

  pi.on("tool_call", (event) => {
    if (!isToolCallEventType<"Agent", AgentToolInput>("Agent", event)) return;
    if (event.input.isolation !== "worktree") return;

    // Tool-call handlers run before execution. Normalize a stale or mistaken
    // worktree request so the subagent continues in the current checkout
    // instead of returning an error that can trigger a retry loop.
    delete event.input.isolation;
  });
}
