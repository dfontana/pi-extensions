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

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { HelixEditor } from "./editor.js";

export default function (pi: ExtensionAPI): void {
  let helixEnabled = true;

  // Saved factory from before we installed our own.
  let previousFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
  let helixInstalled = false;

  function installHelix(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (helixInstalled) return;
    previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new HelixEditor(tui, theme, keybindings),
    );
    helixInstalled = true;
  }

  function uninstallHelix(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!helixInstalled) return;
    ctx.ui.setEditorComponent(previousFactory);
    helixInstalled = false;
    previousFactory = undefined;
  }

  // ── session_start: install the helix editor ──────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    if (!helixEnabled) return;
    installHelix(ctx);
  });

  // ── session_shutdown: restore default editor ─────────────────────────────
  pi.on("session_shutdown", (_event, ctx) => {
    uninstallHelix(ctx);
  });

  // ── /helix command ────────────────────────────────────────────────────────
  pi.registerCommand("helix", {
    description: "Toggle Helix modal editing on/off.",
    handler: (_args, ctx) => {
      // Always toggle — no on/off argument paths
      if (helixEnabled) {
        helixEnabled = false;
        uninstallHelix(ctx);
        ctx.ui.notify("Helix mode off", "info");
      } else {
        helixEnabled = true;
        installHelix(ctx);
        ctx.ui.notify("Helix mode on", "info");
      }
    },
  });
}
