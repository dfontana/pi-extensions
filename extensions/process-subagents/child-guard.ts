import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CHILD_MANIFEST_COMMAND,
  CHILD_MANIFEST_TYPE,
  type ChildManifest,
} from "./contracts.ts";

export default function childGuard(pi: ExtensionAPI) {
  pi.registerCommand(CHILD_MANIFEST_COMMAND, {
    description: "Private process-subagent launch handshake",
    handler: async (_args, ctx) => {
      const manifest: ChildManifest = {
        version: 1,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinking: pi.getThinkingLevel(),
        tools: pi.getActiveTools().sort(),
      };
      pi.appendEntry(CHILD_MANIFEST_TYPE, manifest);
    },
  });
}
