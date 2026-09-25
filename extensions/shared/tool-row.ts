/**
 * Compact tool rows: one shared renderCall/renderResult pair so every tool in
 * this repo draws the same way.
 *
 * - The title line is `name <status> <segments…>`. Collapsed, it is a single
 *   line truncated with "..."; expanded, it wraps so nothing is hidden.
 * - Collapsed rows have no body. Expanded rows show the tool's body on success
 *   (or while running, if the tool opts in) and the error text on failure.
 * - Parameters always render in the title, including on failure, so the
 *   inputs stay visible without expanding.
 *
 * - The row can be selected and toggled on its own from the keyboard (see
 *   tool-focus.ts); a selected row's title starts with a marker.
 *
 * pi never passes the result to renderCall, but it renders the call slot and
 * then the result slot in the same pass, and a Box re-renders its children on
 * every frame. The title is therefore built lazily at render() time from the
 * details renderResult stored in row state, so result summaries appear in the
 * title without an extra invalidate round-trip.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { isToolRowSelected, toolRowExpanded, toolRowRendered, trackToolRow } from "./tool-focus.ts";
import { formatTokens } from "./usage-helpers.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Shared glyph for any context-size parameter (context windows, search context). */
export const CONTEXT_ICON = "⧉";

export type RowStatus = "running" | "queued" | "success" | "error";

/** The subset of pi's Theme the row needs; tests pass a plain stub. */
export interface RowTheme {
  fg(color: any, text: string): string;
  bold(text: string): string;
}

/** The subset of pi's ToolRenderContext the row reads. */
export interface RowContext<Args> {
  args: Args;
  /** Stable per tool call; rows without one cannot be selected. */
  toolCallId?: string;
  state: any;
  lastComponent: Component | undefined;
  invalidate: () => void;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
}

export interface TitleInput<Args, Details> {
  args: Args;
  /** Latest details from a partial or final result; sticky across results without details. */
  details: Details | undefined;
  status: RowStatus;
  theme: RowTheme;
}

export interface BodyInput<Args, Details> extends TitleInput<Args, Details> {
  result: AgentToolResult<unknown>;
  isPartial: boolean;
  lastComponent: Component | undefined;
}

export type Segment = string | false | 0 | null | undefined;

export interface CompactRowSpec<Args, Details> {
  /** Tool name shown first in the title. */
  name: string;
  /** Title segments after the name and status icon; falsy entries are dropped. */
  title(input: TitleInput<Args, Details>): Segment[];
  /**
   * Derive title/body details from a result (usually by narrowing
   * `result.details`). Undefined keeps the previous details. Defaults to the
   * raw `result.details`.
   */
  details?(result: AgentToolResult<unknown>): Details | undefined;
  /** Whether a running call is still waiting for a slot (shown as a dot instead of a spinner). */
  queued?(details: Details | undefined): boolean;
  /**
   * Expanded body. Return undefined for the default: the error text on
   * failure, the text content on success, and nothing while running.
   */
  body?(input: BodyInput<Args, Details>): Component | undefined;
}

export interface CompactRowRenderers<Args> {
  renderCall(args: Args, theme: RowTheme, context: RowContext<Args>): Component;
  renderResult(
    result: AgentToolResult<any>,
    options: { expanded: boolean; isPartial: boolean },
    theme: RowTheme,
    context: RowContext<Args>,
  ): Component;
}

interface RowState<Details> {
  details?: Details;
}

const EMPTY: Component = { render: () => [], invalidate: () => {} };

/** Title line: truncated with "..." when collapsed, wrapped when expanded. */
class CompactTitle implements Component {
  private build: () => { line: string; animate: boolean } = () => ({ line: "", animate: false });
  private expanded = false;
  private id: string | undefined;
  private invalidateRow: () => void = () => {};
  private tick: ReturnType<typeof setTimeout> | undefined;

  update(
    expanded: boolean,
    id: string | undefined,
    invalidateRow: () => void,
    build: () => { line: string; animate: boolean },
  ): void {
    this.expanded = expanded;
    this.id = id;
    this.invalidateRow = invalidateRow;
    this.build = build;
  }

  render(width: number): string[] {
    const { line, animate } = this.build();
    // Animate only while mounted: each render schedules at most one tick, so a
    // row that is no longer drawn stops ticking on its own.
    if (animate && !this.tick) {
      this.tick = setTimeout(() => {
        this.tick = undefined;
        this.invalidateRow();
      }, SPINNER_INTERVAL_MS);
      this.tick.unref?.();
    }
    const safeWidth = Math.max(1, width);
    const lines = this.expanded
      ? wrapTextWithAnsi(line, safeWidth)
      : // Segments may carry raw newlines (e.g. a multi-line query); a collapsed row stays one line.
        [truncateToWidth(line.replace(/[\r\n\t]+/g, " "), safeWidth, "...")];
    // Added after wrapping/truncation so the invisible probe marker never affects layout.
    const probe = toolRowRendered(this.id, safeWidth);
    if (probe && lines.length > 0) lines[0] = probe + lines[0];
    return lines;
  }

  invalidate(): void {}
}

function rowState<Details>(state: any): RowState<Details> {
  // Namespaced so a tool's own state keys can never collide with the row's.
  return (state.compactRow ??= {}) as RowState<Details>;
}

function baseStatus(context: { isPartial: boolean; isError: boolean }): RowStatus {
  if (context.isPartial) return "running";
  return context.isError ? "error" : "success";
}

function statusIcon(status: RowStatus, theme: RowTheme): string {
  switch (status) {
    case "running":
      return theme.fg("accent", SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]);
    case "queued":
      return theme.fg("muted", "·");
    case "success":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
  }
}

export function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function compactRow<Args, Details = unknown>(spec: CompactRowSpec<Args, Details>): CompactRowRenderers<Args> {
  const parse = spec.details ?? ((result: AgentToolResult<unknown>) => result.details as Details | undefined);
  const resolveStatus = (context: { isPartial: boolean; isError: boolean }, details: Details | undefined): RowStatus => {
    const status = baseStatus(context);
    return status === "running" && spec.queued?.(details) ? "queued" : status;
  };

  return {
    renderCall(args, theme, context) {
      const row = rowState<Details>(context.state);
      const title = context.lastComponent instanceof CompactTitle ? context.lastComponent : new CompactTitle();
      const { isPartial, isError, toolCallId: id } = context;
      if (id !== undefined) trackToolRow(id, context.invalidate);
      // Args may still be streaming (partial or `{}`) when the row first draws.
      const current = (args ?? {}) as Args;
      title.update(toolRowExpanded(id, context.expanded), id, context.invalidate, () => {
        const status = resolveStatus({ isPartial, isError }, row.details);
        const name = (isToolRowSelected(id) ? `${theme.fg("accent", "▶")} ` : "") + theme.fg("toolTitle", theme.bold(spec.name));
        // The title is built inside render(), outside pi's renderer guard, so a
        // throwing formatter must degrade to the bare name rather than crash the TUI.
        let segments: string[];
        try {
          segments = spec.title({ args: current, details: row.details, status, theme }).filter(
            (segment): segment is string => typeof segment === "string" && segment.length > 0,
          );
        } catch {
          segments = [];
        }
        return { line: [name, statusIcon(status, theme), ...segments].join(" "), animate: status === "running" };
      });
      return title;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const row = rowState<Details>(context.state);
      const parsed = parse(result);
      if (parsed !== undefined) row.details = parsed;
      if (context.toolCallId !== undefined) trackToolRow(context.toolCallId, context.invalidate);
      if (!toolRowExpanded(context.toolCallId, expanded)) return EMPTY;

      const status = resolveStatus({ isPartial, isError: context.isError }, row.details);
      const custom = spec.body?.({
        args: (context.args ?? {}) as Args,
        details: row.details,
        status,
        theme,
        result,
        isPartial,
        lastComponent: context.lastComponent,
      });
      if (custom) return custom;

      const text = resultText(result);
      if (context.isError) return new Text(theme.fg("error", text || `${spec.name} failed`), 0, 0);
      if (isPartial) return EMPTY;
      return new Text(theme.fg("toolOutput", text || "(no output)"), 0, 0);
    },
  };
}

// ---- title segment helpers --------------------------------------------------

/** The main subject of a call (agent, query, URL, model). */
export function primary(theme: RowTheme, text: string): string {
  return theme.fg("accent", text);
}

/** A secondary parameter. */
export function param(theme: RowTheme, text: string): string {
  return theme.fg("dim", text);
}

/** A short result summary, shown after the parameters once the call succeeds. */
export function summary(theme: RowTheme, text: string): string {
  return `${theme.fg("muted", "→")} ${theme.fg("muted", text)}`;
}

/** `⧉≥200k` for a minimum context window. */
export function minContextSegment(theme: RowTheme, tokens: number | undefined): string | undefined {
  return tokens === undefined ? undefined : param(theme, `${CONTEXT_ICON}≥${formatTokens(tokens)}`);
}

/** `12k chars`, `1 line`, and similar compact counts. */
export function countLabel(count: number, unit: string): string {
  return `${formatTokens(count)} ${unit}${count === 1 ? "" : "s"}`;
}

/** Collapse whitespace so a free-text parameter fits on the title line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
