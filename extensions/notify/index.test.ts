import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notify from "./index.ts";

type Handler = (...args: any[]) => unknown;
type Mode = "tui" | "rpc" | "json" | "print";

function bind() {
    const handlers = new Map<string, Handler>();
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler);
        },
        registerCommand() {},
    } as unknown as ExtensionAPI;
    notify(pi);
    return handlers;
}

function withoutNotifyEnvironment(): () => void {
    const names = ["KITTY_WINDOW_ID", "PI_NOTIFY_SOUND_CMD", "TMUX", "ZELLIJ", "ZELLIJ_PANE_ID"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    return () => {
        for (const name of names) {
            const value = previous[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    };
}

async function captureStdout(run: () => Promise<void>): Promise<string[]> {
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
    }) as typeof process.stdout.write;
    try {
        await run();
    } finally {
        process.stdout.write = originalWrite;
    }
    return writes;
}

describe("notify index", () => {
    test("registers readiness on agent_settled instead of agent_end", () => {
        const restoreEnvironment = withoutNotifyEnvironment();
        try {
            const handlers = bind();
            assert.ok(handlers.has("agent_settled"));
            assert.equal(handlers.has("agent_end"), false);
        } finally {
            restoreEnvironment();
        }
    });

    test("notifies with the existing bell and OSC output when TUI agent_settled fires", async () => {
        const restoreEnvironment = withoutNotifyEnvironment();
        try {
            const handlers = bind();
            const settled = handlers.get("agent_settled");
            assert.ok(settled);

            const writes = await captureStdout(async () => {
                await settled({ type: "agent_settled" }, { mode: "tui" });
            });

            assert.deepEqual(writes, ["\x07", "\x1b]777;notify;Pi;Ready for input\x07"]);
        } finally {
            restoreEnvironment();
        }
    });

    test("does not write terminal notifications in non-TUI modes", async () => {
        const restoreEnvironment = withoutNotifyEnvironment();
        try {
            for (const mode of ["rpc", "json", "print"] as const satisfies readonly Mode[]) {
                const handlers = bind();
                const settled = handlers.get("agent_settled");
                assert.ok(settled);

                const writes = await captureStdout(async () => {
                    await settled({ type: "agent_settled" }, { mode });
                });

                assert.deepEqual(writes, [], `${mode} should not write terminal output`);
            }
        } finally {
            restoreEnvironment();
        }
    });
});
