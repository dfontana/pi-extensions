/**
 * Pane backends: one interface over kitty remote control (`kitten @`) and
 * zellij CLI actions (`zellij action`).
 *
 * Kitty remote control needs either a listen socket (KITTY_LISTEN_ON) or a
 * controlling tty (auth via KITTY_PUBLIC_KEY escape codes over the tty). pi's
 * children inherit pi's controlling tty, which chains through zmx/SSH back to
 * the user's local kitty — that is what lets a remote agent drive the user's
 * local terminal splits. Whether that path actually works varies by setup, so
 * detection is empirical: each backend is probed with a real command and only
 * a responding backend is used.
 *
 * Commands are built here but executed through an injected Run (type-only
 * mirror of pi.exec) so argv construction stays unit-testable.
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { toKittyKey, toZellijKey } from "./keys.ts";

export type Run = (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface OpenOptions {
  direction: "right" | "down";
  cwd?: string;
  name?: string;
  command?: string;
}

export interface SendOptions {
  text?: string;
  enter?: boolean;
  keys?: string[];
}

export interface ReadOptions {
  scrollback?: boolean;
  ansi?: boolean;
}

/** Backend-independent pane record returned by list(). */
export interface PaneInfo {
  pane_id: string;
  title?: string;
  tab?: string;
  focused: boolean;
  cwd?: string;
  command?: string;
}

export interface PaneBackend {
  readonly name: "kitty" | "zellij";
  /** Cheap end-to-end check that this backend can reach its multiplexer. */
  probe(signal?: AbortSignal): Promise<boolean>;
  /** Open a new pane; resolves to its pane id. */
  open(opts: OpenOptions, signal?: AbortSignal): Promise<string>;
  /** Type text and/or send named keys into a pane. */
  send(paneId: string, opts: SendOptions, signal?: AbortSignal): Promise<void>;
  /** Return the rendered screen contents of a pane. */
  read(paneId: string, opts: ReadOptions, signal?: AbortSignal): Promise<string>;
  close(paneId: string, signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<PaneInfo[]>;
}

const PROBE_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 15_000;

async function execOk(
  run: Run,
  what: string,
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await run(cmd, args, { timeout: COMMAND_TIMEOUT_MS, signal });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

/**
 * The send contract, defined once for every backend: text is typed first,
 * `enter` is a trailing Enter keypress after the text, then the named keys in
 * order.
 */
function normalizeSend(opts: SendOptions): { text?: string; keys: string[] } {
  return { text: opts.text, keys: [...(opts.enter ? ["Enter"] : []), ...(opts.keys ?? [])] };
}

interface KittyWindowListing {
  tabs?: Array<{
    title?: string;
    is_focused?: boolean;
    windows?: Array<{
      id: number;
      title?: string;
      is_focused?: boolean;
      cwd?: string;
      foreground_processes?: Array<{ cmdline?: string[] }>;
    }>;
  }>;
}

export class KittyBackend implements PaneBackend {
  readonly name = "kitty" as const;

  constructor(
    private readonly run: Run,
    private readonly listenOn?: string,
  ) {}

  private args(...rest: string[]): string[] {
    return ["@", ...(this.listenOn ? ["--to", this.listenOn] : []), ...rest];
  }

  private exec(what: string, rest: string[], signal?: AbortSignal): Promise<string> {
    return execOk(this.run, what, "kitten", this.args(...rest), signal);
  }

  /** `--match` accepts boolean query expressions, so ids must stay strictly numeric. */
  private matchArg(paneId: string): string {
    if (!/^\d+$/.test(paneId)) {
      throw new Error(`Invalid kitty window id "${paneId}" (expected a number, e.g. "3")`);
    }
    return `id:${paneId}`;
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await this.run("kitten", this.args("ls"), { timeout: PROBE_TIMEOUT_MS, signal });
      return r.code === 0 && r.stdout.trim().startsWith("[");
    } catch {
      return false;
    }
  }

  async open(opts: OpenOptions, signal?: AbortSignal): Promise<string> {
    // vsplit puts the new window beside the current one, hsplit below it (in
    // non-splits layouts kitty ignores the hint and just places the window).
    // --keep-focus so the user's cursor stays where they are working.
    const rest = [
      "launch",
      "--type=window",
      `--location=${opts.direction === "down" ? "hsplit" : "vsplit"}`,
      "--keep-focus",
    ];
    if (opts.cwd) rest.push(`--cwd=${opts.cwd}`);
    if (opts.name) rest.push(`--title=${opts.name}`);
    // --hold keeps the window open after the command exits so its final
    // output/exit state stays readable.
    if (opts.command) rest.push("--hold", "sh", "-c", opts.command);
    const out = (await this.exec("kitten @ launch", rest, signal)).trim();
    if (!/^\d+$/.test(out)) {
      throw new Error(`kitten @ launch returned unexpected output: ${out || "(empty)"}`);
    }
    return out;
  }

  async send(paneId: string, opts: SendOptions, signal?: AbortSignal): Promise<void> {
    const match = this.matchArg(paneId);
    const { text, keys } = normalizeSend(opts);
    // Translate every key before any command runs so a bad spec fails atomically.
    const kittyKeys = keys.map(toKittyKey);
    if (text !== undefined) {
      // send-text applies Python escape rules; double the backslashes so the
      // agent's text lands literally.
      const payload = text.replace(/\\/g, "\\\\");
      await this.exec("kitten @ send-text", ["send-text", "--match", match, "--", payload], signal);
    }
    // One call per key: a multi-key send-key holds all keys down and releases
    // them in reverse (chord semantics), not sequential presses.
    for (const key of kittyKeys) {
      await this.exec("kitten @ send-key", ["send-key", "--match", match, key], signal);
    }
  }

  async read(paneId: string, opts: ReadOptions, signal?: AbortSignal): Promise<string> {
    const rest = ["get-text", "--match", this.matchArg(paneId)];
    if (opts.scrollback) rest.push("--extent=all");
    if (opts.ansi) rest.push("--ansi");
    return await this.exec("kitten @ get-text", rest, signal);
  }

  async close(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.exec("kitten @ close-window", ["close-window", "--match", this.matchArg(paneId)], signal);
  }

  async list(signal?: AbortSignal): Promise<PaneInfo[]> {
    // `ls` dumps every window's full env; flatten to the fields an agent needs.
    const out = await this.exec("kitten @ ls", ["ls"], signal);
    const osWindows = JSON.parse(out) as KittyWindowListing[];
    const panes: PaneInfo[] = [];
    for (const os of osWindows) {
      for (const tab of os.tabs ?? []) {
        for (const win of tab.windows ?? []) {
          panes.push({
            pane_id: String(win.id),
            title: win.title,
            tab: tab.title,
            focused: Boolean(win.is_focused && tab.is_focused),
            cwd: win.cwd,
            command: win.foreground_processes?.[0]?.cmdline?.join(" "),
          });
        }
      }
    }
    return panes;
  }
}

interface ZellijPaneListing {
  id: number;
  is_plugin?: boolean;
  is_focused?: boolean;
  title?: string;
  terminal_command?: string | null;
  tab_name?: string;
}

export class ZellijBackend implements PaneBackend {
  readonly name = "zellij" as const;

  constructor(private readonly run: Run) {}

  private exec(what: string, rest: string[], signal?: AbortSignal): Promise<string> {
    return execOk(this.run, what, "zellij", ["action", ...rest], signal);
  }

  private paneArg(paneId: string): string {
    if (!/^(terminal_\d+|plugin_\d+|\d+)$/.test(paneId)) {
      throw new Error(`Invalid zellij pane id "${paneId}" (expected e.g. "terminal_2")`);
    }
    return paneId;
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await this.run("zellij", ["action", "list-panes"], {
        timeout: PROBE_TIMEOUT_MS,
        signal,
      });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async open(opts: OpenOptions, signal?: AbortSignal): Promise<string> {
    const rest = ["new-pane", "-d", opts.direction];
    if (opts.name) rest.push("-n", opts.name);
    if (opts.cwd) rest.push("--cwd", opts.cwd);
    if (opts.command) rest.push("--", "sh", "-c", opts.command);
    const out = (await this.exec("zellij action new-pane", rest, signal)).trim();
    const id = out.match(/(terminal|plugin)_\d+/)?.[0];
    if (!id) {
      throw new Error(`zellij action new-pane returned unexpected output: ${out || "(empty)"}`);
    }
    return id;
  }

  async send(paneId: string, opts: SendOptions, signal?: AbortSignal): Promise<void> {
    const pane = this.paneArg(paneId);
    const { text, keys } = normalizeSend(opts);
    // Translate every key before any command runs so a bad spec fails atomically.
    const zellijKeys = keys.map(toZellijKey);
    if (text !== undefined) {
      // write-chars types the argument literally (no escape interpretation).
      await this.exec("zellij action write-chars", ["write-chars", "-p", pane, text], signal);
    }
    if (zellijKeys.length > 0) {
      await this.exec("zellij action send-keys", ["send-keys", "-p", pane, ...zellijKeys], signal);
    }
  }

  async read(paneId: string, opts: ReadOptions, signal?: AbortSignal): Promise<string> {
    const rest = ["dump-screen", "-p", this.paneArg(paneId)];
    if (opts.scrollback) rest.push("-f");
    if (opts.ansi) rest.push("-a");
    return await this.exec("zellij action dump-screen", rest, signal);
  }

  async close(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.exec("zellij action close-pane", ["close-pane", "-p", this.paneArg(paneId)], signal);
  }

  async list(signal?: AbortSignal): Promise<PaneInfo[]> {
    const out = await this.exec(
      "zellij action list-panes",
      ["list-panes", "-j", "-s", "-c", "-t"],
      signal,
    );
    const panes = JSON.parse(out) as ZellijPaneListing[];
    return panes.map((p) => ({
      pane_id: `${p.is_plugin ? "plugin" : "terminal"}_${p.id}`,
      title: p.title,
      tab: p.tab_name,
      focused: Boolean(p.is_focused),
      command: p.terminal_command ?? undefined,
    }));
  }
}

export type DetectResult =
  | { backend: PaneBackend }
  | { backend?: undefined; reason: string };

/**
 * Pick the pane backend for this environment: kitty when its remote control
 * answers (preferred — including over SSH via the tty), else zellij when
 * inside a live zellij session. When neither answers, `reason` says which
 * probes were attempted and why nothing registered.
 */
export async function detectBackend(
  env: Record<string, string | undefined>,
  run: Run,
): Promise<DetectResult> {
  const kittyCandidate = Boolean(
    env.KITTY_LISTEN_ON || env.KITTY_WINDOW_ID || env.TERM?.includes("kitty"),
  );
  const kitty = kittyCandidate ? new KittyBackend(run, env.KITTY_LISTEN_ON) : undefined;
  // ZELLIJ may be "0" while a session is still reachable (see the tui-iteration
  // skill): the CLI targets it through ZELLIJ_SESSION_NAME, so that is the signal.
  const zellij = env.ZELLIJ_SESSION_NAME ? new ZellijBackend(run) : undefined;

  // Probe both candidates concurrently (each timeout-bounded, never rejecting);
  // kitty keeps preference through the await order.
  const kittyProbe = kitty?.probe();
  const zellijProbe = zellij?.probe();

  const failures: string[] = [];
  if (kitty) {
    if (await kittyProbe) return { backend: kitty };
    failures.push(
      "kitty env detected but `kitten @ ls` did not respond (is allow_remote_control enabled?)",
    );
  }
  if (zellij) {
    if (await zellijProbe) return { backend: zellij };
    failures.push(
      `ZELLIJ_SESSION_NAME=${env.ZELLIJ_SESSION_NAME} set but \`zellij action\` did not respond`,
    );
  }
  return {
    reason: failures.length > 0 ? failures.join("; ") : "not running inside kitty or zellij",
  };
}
