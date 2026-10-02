/**
 * builtin-rows — draws pi's built-in read, write, bash, grep, find, and ls
 * tools with the shared compact row (extensions/shared/tool-row.ts).
 *
 * pi has no render-only hook, so each tool is re-registered from pi's own
 * definition factory with the same options pi derives from settings; only the
 * renderers change. Expanded rows show pi's stock call + result rendering,
 * loaded from pi's (non-exported) renderer module, so upstream rendering
 * changes still appear there.
 *
 * Both the factory options and the renderer module are pi internals, so the
 * override applies only on the pi version it was verified against; any other
 * version keeps pi's own rendering and warns. See .pi/skills/bump-pi-version.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getPackageDir,
  VERSION,
  type BashToolInput,
  type BashToolOptions,
  type ExtensionAPI,
  type FindToolInput,
  type FindToolOptions,
  type GrepToolInput,
  type GrepToolOptions,
  type LsToolInput,
  type LsToolOptions,
  type ReadToolInput,
  type ReadToolOptions,
  type ToolDefinition,
  type WriteToolInput,
  type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
// Type-only, so it is erased at runtime: typecheck fails if pi moves or reshapes the renderer module.
import type * as StockRendererModule from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { toolRowExpanded } from "../shared/tool-focus.ts";
import { compactRow, countLabel, param, primary, tail, type Segment, type TitleInput } from "../shared/tool-row.ts";

/** The pi version whose tool options and renderer module were last checked by hand. */
const VERIFIED_PI_VERSION = "0.99.1";

// If pi adds a factory option, typecheck fails here: check whether pi now
// passes it from settings (AgentSession._buildRuntime) and mirror it below.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const knownOptions: [
  Same<keyof ReadToolOptions, "autoResizeImages" | "resizeOptions" | "operations">,
  Same<keyof BashToolOptions, "operations" | "commandPrefix" | "shellPath" | "exposeSessionEnvironment" | "spawnHook">,
  Same<keyof WriteToolOptions | keyof GrepToolOptions | keyof FindToolOptions | keyof LsToolOptions, "operations">,
] = [true, true, true];
void knownOptions;

type Renderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;
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
  args.limit !== undefined && param(theme, `limit=${args.limit}`);

const titles = {
  read: (input: TitleInput<ReadToolInput, unknown>) => [
    input.args.offset !== undefined && param(input.theme, `offset=${input.args.offset}`),
    limit(input),
    pathTail(input),
  ],
  write: (input: TitleInput<WriteToolInput, unknown>) => [
    typeof input.args.content === "string" && param(input.theme, countLabel(input.args.content.split("\n").length, "line")),
    pathTail(input),
  ],
  bash: ({ args, theme }: TitleInput<BashToolInput, unknown>) => [
    args.timeout !== undefined && param(theme, `timeout=${args.timeout}s`),
    typeof args.command === "string" && primary(theme, args.command),
  ],
  grep: (input: TitleInput<GrepToolInput, unknown>) => {
    const { args, theme } = input;
    return [
      typeof args.pattern === "string" && primary(theme, args.pattern),
      args.glob && param(theme, `glob=${args.glob}`),
      args.ignoreCase && param(theme, "ignoreCase"),
      args.literal && param(theme, "literal"),
      args.context !== undefined && param(theme, `context=${args.context}`),
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
function compactWithStockBody(name: string, stock: Renderers, title: Title<any>): Required<Renderers> {
  let body: Component | undefined; // handed to compactRow's body() during a renderResult call
  const row = compactRow({ name, title, body: () => body });
  const own = (state: any): { call?: Component; result?: Component; live?: boolean; settled?: boolean } =>
    (state.stockRow ??= {});
  return {
    renderCall(args, theme, context) {
      const state = own(context.state);
      state.call = attempt(() => stock.renderCall!(args, theme, { ...context, expanded: true, lastComponent: state.call }));
      return row.renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const state = own(context.state);
      // Once live, keep feeding the stock renderer so it can settle (bash stops its timer).
      if (toolRowExpanded(context.toolCallId, options.expanded)) state.live = true;
      if (state.live || (!options.isPartial && !state.settled)) {
        state.result = attempt(() =>
          stock.renderResult!(result, { ...options, expanded: true }, theme, { ...context, expanded: true, lastComponent: state.result }),
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

async function loadStockRenderers(): Promise<Record<keyof typeof titles, Renderers> | string> {
  if (VERSION !== VERIFIED_PI_VERSION) return `pi ${VERSION} is unverified (last verified ${VERIFIED_PI_VERSION})`;
  try {
    const url = pathToFileURL(join(getPackageDir(), "dist/core/tools/renderers/index.js")).href;
    const stock: typeof StockRendererModule = await import(url);
    const renderers = {
      read: stock.readRenderers,
      write: stock.writeRenderers,
      bash: stock.createShellRenderers("$"),
      grep: stock.grepRenderers,
      find: stock.findRenderers,
      ls: stock.lsRenderers,
    };
    const missing = Object.entries(renderers).filter(([, r]) => typeof r?.renderCall !== "function" || typeof r?.renderResult !== "function");
    return missing.length ? `pi's renderers are missing for ${missing.map(([n]) => n).join(", ")}` : renderers;
  } catch (error) {
    return `could not load pi's renderers (${error instanceof Error ? error.message : String(error)})`;
  }
}

export default function (pi: ExtensionAPI) {
  let warned = false;
  pi.on("session_start", async (_event, ctx) => {
    const stock = await loadStockRenderers();
    if (typeof stock === "string") {
      if (!warned) ctx.ui.notify(`builtin-rows: ${stock}; built-in tools keep pi's rendering. See the bump-pi-version skill.`, "warning");
      warned = true;
      return;
    }

    // Mirror the options pi builds its own tools with (AgentSession._buildRuntime).
    const settings = pi.getSettings();
    const read = { autoResizeImages: settings.images?.autoResize ?? true };
    const bash = { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath?.replace(/^~(?=\/|$)/, homedir()) };

    const override = (definition: ToolDefinition<any, any>, name: keyof typeof titles, inactive = false) =>
      pi.registerTool({
        ...definition,
        ...compactWithStockBody(name, stock[name], titles[name]),
        // Registering activates a tool by default; grep/find/ls are off unless the user enables them.
        ...(inactive && { defaultActive: false }),
      });
    override(createReadToolDefinition(ctx.cwd, read), "read");
    override(createWriteToolDefinition(ctx.cwd), "write");
    override(createBashToolDefinition(ctx.cwd, bash), "bash");
    override(createGrepToolDefinition(ctx.cwd), "grep", true);
    override(createFindToolDefinition(ctx.cwd), "find", true);
    override(createLsToolDefinition(ctx.cwd), "ls", true);
  });
}
