/**
 * prompt-stash — Pi extension
 *
 * Stashes and un-stashes the current prompt editor content with Alt+Shift+S.
 * Shows a footer indicator when stashed. Only durable to the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "prompt-stash";

export default function (pi: ExtensionAPI): void {
  // Per-session stash.  null = nothing stashed.
  let stash: string | null = null;

  // Reset stash when a session starts
  pi.on("session_start", (_event, ctx) => {
    stash = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerShortcut("alt+shift+s", {
    description: "Stash / un-stash the current prompt (Alt+Shift+S)",
    handler: (ctx) => {
      if (stash === null) {
        const text = ctx.ui.getEditorText();
        if (!text.trim()) {
          ctx.ui.notify("Nothing to stash", "info");
          return;
        }
        stash = text;
        ctx.ui.setEditorText("");
        ctx.ui.setStatus(STATUS_KEY, "● stashed");
      } else {
        ctx.ui.setEditorText(stash);
        stash = null;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
