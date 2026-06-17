/**
 * hashline — content-hash-anchored file reading and editing, plus always-on
 * usage statistics.
 *
 * Motivation (https://blog.can.ac/2026/02/12/the-harness-problem/): line numbers
 * are a fragile edit anchor because the file can change between read and edit.
 * hashline gives every line a short content hash and requires edits to cite
 * `line:hash`. On apply we recompute the hash for that line number; if it has
 * drifted the whole edit is rejected with an actionable diff so the model
 * re-reads and retries instead of corrupting the file.
 *
 * Tools:
 *   - hashline_read: like the built-in `read` but returns `LINENUM:HASH|CONTENT`
 *     rows (see hash.ts).
 *   - hashline_edit: applies a structured list of hash-anchored operations
 *     (see apply.ts) and rejects on any stale anchor.
 *
 * Toggle: `/hashline` flips the extension on/off. State persists to
 * ~/.pi/agent/hashline.json across restarts; default ON. When OFF, the tools
 * politely defer to the built-in read/edit.
 *
 * Statistics: a tool_result handler records EVERY edit/read-class result — both
 * the built-in tools and ours — into ~/.pi/agent/hashline-stats.json, bucketed
 * by whether hashline was active at the time. This runs even when the tools are
 * disabled, so the native-edit baseline accumulates too. See stats.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isEditToolResult, isReadToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatHashlines, splitLines } from "./hash.ts";
import { applyEdits, type Anchor, type EditOp } from "./apply.ts";
import { recordEvent } from "./stats.ts";

const STATE_PATH = join(getAgentDir(), "hashline.json");

/** First text block of a tool result, or "" — the shape recurs in renderResult. */
function firstText(result: AgentToolResult<unknown>): string {
  const first = result.content?.[0];
  return first?.type === "text" ? first.text : "";
}

/**
 * Tool-call ids whose hashline_edit was rejected for a hash mismatch. `execute`
 * records the id here right before throwing; the tool_result handler consumes it
 * (delete-on-read) to count the rejection — carrying the structured `mismatch`
 * flag across the throw boundary without parsing the rendered error text.
 */
const mismatchCalls = new Set<string>();

// Module-level toggle. Default OFF; loaded from disk at session_start.
let enabled = false;

function loadEnabled(): void {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { enabled?: boolean };
    if (typeof parsed.enabled === "boolean") enabled = parsed.enabled;
  } catch {
    // missing/corrupt -> keep default
  }
}

function saveEnabled(): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify({ enabled }, null, 2), "utf8");
  } catch {
    // best-effort persistence
  }
}

const DISABLED_READ_MSG =
  "hashline is disabled. Use the built-in `read` tool instead (enable hashline with /hashline).";
const DISABLED_EDIT_MSG =
  "hashline is disabled. Use the built-in `edit` tool instead (enable hashline with /hashline).";

const anchorSchema = Type.Object({
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  hash: Type.String({ description: "The line's hash from the latest hashline_read." }),
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    loadEnabled();
  });

  // ── /hashline toggle ──────────────────────────────────────────────────────
  pi.registerCommand("hashline", {
    description: "Toggle hashline (content-hash-anchored read/edit) on/off.",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      saveEnabled();
      ctx.ui.notify(`hashline ${enabled ? "on" : "off"}`, "info");
    },
  });

  // ── hashline_read ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hashline_read",
    label: "Hashline Read",
    description:
      "Read a text file as numbered, content-hashed rows formatted `LINENUM:HASH|CONTENT`. " +
      "Use the LINENUM and HASH from this output to anchor edits via hashline_edit.",
    promptSnippet: "Read a file with per-line content hashes for safe editing",
    parameters: Type.Object({
      path: Type.String({ description: "File path (absolute or relative to cwd)." }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max lines to return." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return { content: [{ type: "text", text: DISABLED_READ_MSG }], details: undefined };
      }
      const abs = resolvePath(ctx.cwd, params.path);
      const raw = readFileSync(abs, "utf8");
      const all = splitLines(raw);
      const start = params.offset ?? 1;
      const end = params.limit ? start + params.limit - 1 : all.length;
      const slice = all.slice(start - 1, end).join("\n");
      const text = formatHashlines(slice, start);
      return {
        content: [{ type: "text", text: text || "(empty file)" }],
        details: { path: abs, lines: all.length },
      };
    },
    renderResult(result, _opts, theme, context) {
      const body = firstText(result);
      if (context.isError) return new Text(theme.fg("error", body || "hashline_read failed"), 0, 0);
      const n = body ? body.split("\n").length : 0;
      return new Text(theme.fg("muted", `${n} line${n === 1 ? "" : "s"}`), 0, 0);
    },
  });

  // ── hashline_edit ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hashline_edit",
    label: "Hashline Edit",
    description:
      "Edit a file via hash-anchored operations. Each anchor cites the line:hash from a recent " +
      "hashline_read; if any anchor's hash no longer matches the current file the entire edit is " +
      "rejected (re-read and retry). All ops address ORIGINAL line numbers; ops must not overlap.",
    promptSnippet: "Edit a file using hash-anchored operations",
    parameters: Type.Object({
      path: Type.String({ description: "File path (absolute or relative to cwd)." }),
      operations: Type.Array(
        Type.Object({
          op: Type.Union([
            Type.Literal("replace"),
            Type.Literal("insert_before"),
            Type.Literal("insert_after"),
            Type.Literal("insert_head"),
            Type.Literal("insert_tail"),
            Type.Literal("delete"),
          ]),
          line: Type.Optional(Type.Integer({ minimum: 1, description: "Anchor line (1-based)." })),
          hash: Type.Optional(Type.String({ description: "Anchor line's hash." })),
          to: Type.Optional(anchorSchema),
          body: Type.Optional(
            Type.Array(Type.String(), {
              description: "Replacement / inserted lines (no trailing newlines).",
            }),
          ),
        }),
        { minItems: 1, description: "Operations applied against original line numbers." },
      ),
    }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      if (!enabled) {
        return { content: [{ type: "text", text: DISABLED_EDIT_MSG }], details: undefined };
      }
      const abs = resolvePath(ctx.cwd, params.path);
      const original = readFileSync(abs, "utf8");

      const ops: EditOp[] = [];
      for (const o of params.operations) {
        const body = o.body ?? [];
        const to = o.to as Anchor | undefined;
        if (o.op === "insert_head" || o.op === "insert_tail") {
          ops.push({ op: o.op, body });
          continue;
        }
        // replace / delete / insert_before / insert_after all need an anchor;
        // apply.ts ignores the fields each variant doesn't use.
        if (o.line === undefined || o.hash === undefined) {
          throw new Error(`op ${o.op} requires line and hash`);
        }
        ops.push({ op: o.op, line: o.line, hash: o.hash, to, body } as EditOp);
      }

      const result = applyEdits(original, ops);
      if (!result.ok) {
        // Tools signal failure by throwing; carry the structured mismatch flag to
        // the tool_result handler via mismatchCalls so stats don't parse the text.
        if (result.mismatch) mismatchCalls.add(id);
        const prefix = result.mismatch ? "Edit rejected (hash mismatch).\n" : "Edit rejected.\n";
        throw new Error(prefix + result.error);
      }

      writeFileSync(abs, result.content, "utf8");
      const after = formatHashlines(result.content);
      return {
        content: [
          {
            type: "text",
            text: `Applied ${ops.length} operation(s) to ${params.path}.\n\nUpdated file:\n${after}`,
          },
        ],
        details: { path: abs, ops: ops.length },
      };
    },
    renderResult(result, _opts, theme, context) {
      const body = firstText(result);
      if (context.isError) {
        const oneLine = body.split("\n")[0] || "hashline_edit failed";
        return new Text(theme.fg("error", oneLine), 0, 0);
      }
      return new Text(theme.fg("muted", body.split("\n")[0] || "edit applied"), 0, 0);
    },
  });

  // ── statistics: record EVERY edit/read-class result, always ───────────────
  pi.on("tool_result", (event) => {
    const bucket = enabled ? "active" : "inactive";
    const path = typeof event.input?.path === "string" ? event.input.path : "";

    if (isReadToolResult(event) || event.toolName === "hashline_read") {
      recordEvent({ bucket, tool: event.toolName, path, isError: event.isError, kind: "read" });
      return;
    }

    if (isEditToolResult(event) || event.toolName === "hashline_edit") {
      // execute() flagged hash-mismatch rejections in mismatchCalls; consume the
      // flag here (delete-on-read also keeps the set bounded).
      const hashMismatch = mismatchCalls.delete(event.toolCallId);
      recordEvent({
        bucket,
        tool: event.toolName,
        path,
        isError: event.isError,
        kind: "edit",
        hashMismatch,
      });
    }
  });
}
