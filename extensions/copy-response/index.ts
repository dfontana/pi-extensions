/**
 * copy-response — Pi extension
 *
 * `/cp` parses the last assistant response and offers to copy the whole thing
 * or any individual fenced code block. Copied content is whitespace-normalized
 * (trailing whitespace stripped, leading/trailing blank lines dropped, code
 * blocks dedented) so it keeps its formatting when pasted elsewhere.
 */

import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildCopyOptions } from "./blocks.ts";

/** Concatenated text of the most recent assistant message, or null if none. */
function lastAssistantText(ctx: ExtensionCommandContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const parts = (entry.message as { content?: unknown }).content;
    if (!Array.isArray(parts)) return null;
    return parts
      .filter(
        (p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return null;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cp", {
    description: "Copy the last response or a code block, with whitespace normalized",
    handler: async (_args, ctx) => {
      const text = lastAssistantText(ctx);
      if (text === null || text.trim() === "") {
        ctx.ui.notify("No assistant response to copy", "warning");
        return;
      }

      const options = buildCopyOptions(text);

      // Only "Entire response" (no fenced blocks) or no dialog UI: copy directly.
      let chosen = options[0];
      if (options.length > 1 && ctx.hasUI) {
        const label = await ctx.ui.select(
          "Copy to clipboard",
          options.map((o) => o.label),
        );
        if (label === undefined) return; // cancelled
        const match = options.find((o) => o.label === label);
        if (!match) return;
        chosen = match;
      }

      if (chosen.content.length === 0) {
        ctx.ui.notify("Nothing to copy", "warning");
        return;
      }

      await copyToClipboard(chosen.content);
      const n = chosen.lineCount;
      ctx.ui.notify(`Copied ${n} line${n === 1 ? "" : "s"} to clipboard`, "info");
    },
  });
}
