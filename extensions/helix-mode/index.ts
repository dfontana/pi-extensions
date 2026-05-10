/**
 * helix-mode — Pi extension
 *
 * Installs a Helix-style modal editor (Normal / Insert / Select modes) as the
 * main TUI input component. Enabled by default; toggle with `/helix [on|off]`.
 *
 * Key features:
 *   - Normal mode: hjkl + arrow aliases, w/b/e, 0/$ word / line navigation
 *   - g-prefix:    gg (buffer start), ge (buffer end), gw (jump-to-word labels)
 *   - Mode entry:  i, a, o, O → Insert;  v → Select;  Escape → Normal
 *   - Changes:     d (delete), c (change), r+char (replace), x (select line)
 *   - Indent:      > / <
 *   - Select mode: all movements extend the selection anchor
 *   - Search:      * (word under cursor → pattern), n/N (next/prev)
 *   - Selection:   s (regex within selection)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HelixEditor } from "./editor.js";

export default function (pi: ExtensionAPI): void {
  let helixEnabled = true;

  // ── session_start: install the helix editor ──────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    if (!helixEnabled) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings));
  });

  // ── session_shutdown: restore default editor ─────────────────────────────
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setEditorComponent(undefined);
  });

  // ── /helix command ────────────────────────────────────────────────────────
  pi.registerCommand("helix", {
    description: "Toggle Helix modal editing on/off. Usage: /helix [on|off]",
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        helixEnabled = true;
        ctx.ui.setEditorComponent((tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings));
        ctx.ui.notify("Helix mode on", "info");
        return;
      }

      if (arg === "off") {
        helixEnabled = false;
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.notify("Helix mode off", "info");
        return;
      }

      // No argument — toggle
      if (helixEnabled) {
        helixEnabled = false;
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.notify("Helix mode off", "info");
      } else {
        helixEnabled = true;
        ctx.ui.setEditorComponent((tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings));
        ctx.ui.notify("Helix mode on", "info");
      }
    },
  });
}
