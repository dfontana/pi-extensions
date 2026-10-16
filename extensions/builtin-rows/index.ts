/**
 * builtin-rows — draws pi's built-in read, write, bash, grep, find, and ls
 * tools with the shared compact row (extensions/shared/tool-row.ts).
 *
 * Purely presentational: a `pi.registerToolRenderer` resolver wraps whatever
 * renderers pi would otherwise use (`next()`, pi's stock ones for built-ins),
 * so the tools themselves, and their settings, stay pi's. Expanded rows show
 * those stock renderers, so upstream rendering changes still appear there.
 *
 * No pi internals are used. If `next()` stops offering a call + result
 * renderer pair in pi's default shell, the tool keeps pi's rendering.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BashToolInput,
  ExtensionAPI,
  FindToolInput,
  GrepToolInput,
  LsToolInput,
  ReadToolInput,
  ToolRenderers,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { toolRowExpanded } from "../shared/tool-focus.ts";
import { compactRow, countLabel, param, primary, tail, type Segment, type TitleInput } from "../shared/tool-row.ts";

type Renderers = Required<Pick<ToolRenderers, "renderCall" | "renderResult">>;
type Title<Args> = (input: TitleInput<Args, unknown>) => Segment[];

/** cwd-relative inside the cwd, `~`-relative under home, absolute otherwise. */
function displayPath(path: string, cwd: string): string {
  const home = homedir();
  const abs = resolve(cwd, path.replace(/^~(?=\/|$)/, home));
  const rel = relative(cwd, abs);
  if (rel === "") return ".";
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  return abs === home || abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
}

const pathTail = (input: TitleInput<{ path?: string }, unknown>, fallback?: string) => {
  const path = typeof input.args.path === "string" ? input.args.path : fallback;
  return path !== undefined && tail(displayPath(path, input.cwd ?? process.cwd()), (text) => primary(input.theme, text));
};

const limit = ({ args, theme }: TitleInput<{ limit?: number }, unknown>) =>
  args.limit != null && param(theme, `limit=${args.limit}`);

const titles = {
  read: (input: TitleInput<ReadToolInput, unknown>) => [
    input.args.offset != null && param(input.theme, `offset=${input.args.offset}`),
    limit(input),
    pathTail(input),
  ],
  write: (input: TitleInput<WriteToolInput, unknown>) => [
    typeof input.args.content === "string" && param(input.theme, countLabel(input.args.content.split("\n").length, "line")),
    pathTail(input),
  ],
  bash: ({ args, theme }: TitleInput<BashToolInput, unknown>) => [
    args.timeout != null && param(theme, `timeout=${args.timeout}s`),
    typeof args.command === "string" && primary(theme, args.command),
  ],
  grep: (input: TitleInput<GrepToolInput, unknown>) => {
    const { args, theme } = input;
    return [
      typeof args.pattern === "string" && primary(theme, args.pattern),
      args.glob && param(theme, `glob=${args.glob}`),
      args.ignoreCase && param(theme, "ignoreCase"),
      args.literal && param(theme, "literal"),
      args.context != null && param(theme, `context=${args.context}`),
      limit(input),
      pathTail(input, "."),
    ];
  },
  find: (input: TitleInput<FindToolInput, unknown>) => [
    typeof input.args.pattern === "string" && primary(input.theme, input.args.pattern),
    limit(input),
    pathTail(input, "."),
  ],
  ls: (input: TitleInput<LsToolInput, unknown>) => [limit(input), pathTail(input, ".")],
};

/** A pi renderer throwing must not take the compact row down with it. */
function attempt(render: () => Component | undefined): Component | undefined {
  try {
    return render();
  } catch {
    return undefined;
  }
}

/**
 * Compact title, with pi's stock call + result rendering as the expanded body.
 * The stock call renderer runs on every pass to keep its state current (bash
 * times the run from it). The stock result renderer runs once when the call
 * settles (bash records its end time) and on every pass once the row has been
 * expanded, so collapsed rows never pay for it (read highlights the whole file).
 */
function compactWithStockBody(name: string, stock: Renderers, title: Title<any>): Renderers {
  let body: Component | undefined; // handed to compactRow's body() during a renderResult call
  const row = compactRow({ name, title, body: () => body });
  const own = (state: any): { call?: Component; result?: Component; live?: boolean; settled?: boolean } =>
    (state.stockRow ??= {});
  return {
    renderCall(args, theme, context) {
      const state = own(context.state);
      state.call = attempt(() => stock.renderCall(args, theme, { ...context, expanded: true, lastComponent: state.call }));
      return row.renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const state = own(context.state);
      // Once live, keep feeding the stock renderer so it can settle (bash stops its timer).
      if (toolRowExpanded(context.toolCallId, options.expanded)) state.live = true;
      if (state.live || (!options.isPartial && !state.settled)) {
        state.result = attempt(() =>
          stock.renderResult(result, { ...options, expanded: true }, theme, { ...context, expanded: true, lastComponent: state.result }),
        );
      }
      if (!options.isPartial) state.settled = true;
      if (state.result) {
        const stack = new Container();
        if (state.call) stack.addChild(state.call);
        stack.addChild(state.result);
        body = stack;
      }
      try {
        return row.renderResult(result, options, theme, context);
      } finally {
        body = undefined;
      }
    },
  };
}

const hasTitle = (name: string): name is keyof typeof titles => Object.hasOwn(titles, name);

/** The compact row only fits a call + result renderer pair drawn in pi's default shell. */
const wrappable = (stock: ToolRenderers | undefined): stock is ToolRenderers & Renderers =>
  typeof stock?.renderCall === "function" &&
  typeof stock.renderResult === "function" &&
  (stock.renderShell ?? "default") === "default";

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const stock = next();
    if (!hasTitle(toolName) || !wrappable(stock)) return stock;
    return { ...stock, ...compactWithStockBody(toolName, stock, titles[toolName]) };
  });
}
