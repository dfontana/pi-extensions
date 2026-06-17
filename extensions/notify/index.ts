/**
 * Notify Extension
 *
 * Sends a desktop notification when Pi finishes and is waiting for input.
 * Also adds a "•" prefix to the active Zellij tab on agent_end (cleared on agent_start)
 * so attention is visible from other tabs.
 *
 * Supported notification protocols:
 * - OSC 777: Ghostty, WezTerm, rxvt-unicode, Zellij (0.39+ passthrough)
 * - OSC 99: Kitty
 * - tmux passthrough wrapper for OSC sequences
 * - Optional sound hook via PI_NOTIFY_SOUND_CMD
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "child_process";

// ── tmux passthrough ─────────────────────────────────────────────────────────

function wrapForTmux(sequence: string): string {
    if (!process.env.TMUX) return sequence;
    // tmux passthrough: wrap in DCS and escape inner ESC bytes.
    const escaped = sequence.split("\x1b").join("\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
}

// ── OSC notifications ────────────────────────────────────────────────────────

function notifyOSC777(title: string, body: string): void {
    process.stdout.write(wrapForTmux(`\x1b]777;notify;${title};${body}\x07`));
}

function notifyOSC99(title: string, body: string): void {
    // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
    process.stdout.write(wrapForTmux(`\x1b]99;i=1:d=0;${title}\x1b\\`));
    process.stdout.write(wrapForTmux(`\x1b]99;i=1:p=body;${body}\x1b\\`));
}

function runSoundHook(): void {
    const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
    if (!command) return;
    try {
        const { spawn } = require("node:child_process");
        const child = spawn(command, { shell: true, detached: true, stdio: "ignore" });
        child.unref();
    } catch {
        // Ignore hook errors to avoid breaking notifications
    }
}

function notify(title: string, body: string): void {
    process.env.KITTY_WINDOW_ID ? notifyOSC99(title, body) : notifyOSC777(title, body);
    runSoundHook();
}

// ── Zellij tab dot ───────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
        execFile(cmd, args, { encoding: "utf8", timeout: 3000 }, (err, stdout) =>
            err ? reject(err) : resolve(stdout.trim())
        )
    );
}

/** Resolves the tab-id of the pane running Pi once at startup. */
async function resolveOwnTabId(): Promise<string | null> {
    const paneId = process.env.ZELLIJ_PANE_ID;
    if (!paneId) return null;
    try {
        const raw = await execAsync("zellij", ["action", "list-panes", "--tab", "--json"]);
        const panes: Array<{ id: number; is_plugin: boolean; tab_id: number; tab_name: string }> =
            JSON.parse(raw);
        const pane = panes.find((p) => !p.is_plugin && p.id === Number(paneId));
        if (!pane) return null;
        return String(pane.tab_id);
    } catch {
        return null;
    }
}

/** Fetches the current live name for a tab by id. */
async function getCurrentTabName(tabId: string): Promise<string | null> {
    try {
        const raw = await execAsync("zellij", ["action", "list-panes", "--tab", "--json"]);
        const panes: Array<{ id: number; is_plugin: boolean; tab_id: number; tab_name: string }> =
            JSON.parse(raw);
        const pane = panes.find((p) => p.tab_id === Number(tabId));
        return pane ? pane.tab_name : null;
    } catch {
        return null;
    }
}

/**
 * Adds or removes the "• " dot prefix from the tab's *current* name.
 * Always re-fetches the live name so renames made after startup are respected.
 */
async function setTabDot(add: boolean, tabId: string): Promise<void> {
    const name = await getCurrentTabName(tabId);
    if (name === null) return;
    const hasDot = name.startsWith("• ");
    if (add && !hasDot) {
        await execAsync("zellij", ["action", "rename-tab", `• ${name}`, "--tab-id", tabId]).catch(() => {});
    } else if (!add && hasDot) {
        await execAsync("zellij", ["action", "rename-tab", name.slice(2), "--tab-id", tabId]).catch(() => {});
    }
}

// ── Extension entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const inZellij = process.env.ZELLIJ !== undefined;

    // Tab id resolved once at startup; null outside Zellij or if probe fails.
    // We store only the id so the live tab name is always fetched fresh before
    // acting — avoiding stale-name restores when the user renames the tab.
    const tabIdPromise: Promise<string | null> = inZellij
        ? resolveOwnTabId()
        : Promise.resolve(null);

    pi.registerCommand("ack", {
        description: "Clear the Zellij tab dot (no-op outside Zellij)",
        handler: async (_args, _ctx) => {
            const tabId = await tabIdPromise;
            if (tabId) await setTabDot(false, tabId);
        },
    });

    pi.on("session_shutdown", async (event) => {
        const tabId = await tabIdPromise;
        if (tabId && event.reason === "quit") await setTabDot(false, tabId);
    });

    pi.on("agent_end", async () => {
        notify("Pi", "Ready for input");
        const tabId = await tabIdPromise;
        if (tabId) await setTabDot(true, tabId);
    });

    pi.on("agent_start", async () => {
        const tabId = await tabIdPromise;
        if (tabId) await setTabDot(false, tabId);
    });
}
