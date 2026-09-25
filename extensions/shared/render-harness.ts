/**
 * Test harness for compact tool rows: renders one pi display pass (the call
 * slot, then the result slot when a result is given) the way
 * ToolExecutionComponent does, with a plain-text theme and ANSI stripped.
 */

export const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

export interface RenderableTool {
  renderCall?: (...args: any[]) => { render(width: number): string[] };
  renderResult?: (...args: any[]) => { render(width: number): string[] };
}

export interface RowFlags {
  isPartial?: boolean;
  isError?: boolean;
  expanded?: boolean;
  /** Row state shared across passes (pi keeps one per tool row). */
  state?: Record<string, unknown>;
  width?: number;
}

export type RowResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

const ANSI = /\x1b\[[0-9;]*m/g;

export function textResult(text: string, details?: unknown): RowResult {
  return { content: [{ type: "text", text }], details };
}

export function renderRow(tool: RenderableTool, args: unknown, result?: RowResult, flags: RowFlags = {}) {
  const { state = {}, width = 200, ...rest } = flags;
  const context = {
    args,
    state,
    lastComponent: undefined,
    invalidate() {},
    isPartial: false,
    isError: false,
    expanded: false,
    ...rest,
  };
  const title = tool.renderCall!(args, plainTheme, context);
  const body = result
    ? tool.renderResult!(result, { expanded: context.expanded, isPartial: context.isPartial }, plainTheme, context)
    : undefined;
  const clean = (lines: string[]) => lines.map((line) => line.replace(ANSI, "").trimEnd());
  return { title: clean(title.render(width)).join("\n"), body: clean(body?.render(width) ?? []) };
}
