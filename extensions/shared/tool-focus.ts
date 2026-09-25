/**
 * Keyboard focus for compact tool rows: select one row, toggle it on its own,
 * and scroll it to the top of the transcript. Fullscreen only: regular mode
 * cannot scroll the terminal, and pi's redraw of an off-screen change jumps it
 * to the bottom, so there the keys fall through and no marker is drawn.
 *
 * pi loads every extension with its own module cache, so each extension that
 * imports this file gets a separate copy. All state therefore lives on
 * globalThis under a versioned symbol, shared by the tool rows (which draw the
 * selection marker and apply per-row expansion) and the editor (which owns the
 * keys).
 *
 * pi gives extensions no handle to the transcript's rows or their positions, so
 * the editor locates rows with a probe: it renders the transcript document once
 * with probing enabled, each tool-row title prefixes its line with an invisible
 * marker carrying its toolCallId, and the marker line indexes give both the
 * rows' order and their line offsets. Probe output never reaches the terminal.
 *
 * Per-row expansion is fixed: toggling a row stores an explicit expanded or
 * collapsed state that ignores the global state. Changing the global state
 * (ctrl+o) clears every per-row override, so it still resets all rows at once.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";

const STATE = Symbol.for("pi-extensions.tool-focus.v1");
const PROBE_PREFIX = "\x1b]7777;pi-tool-focus=";
const PROBE_SUFFIX = "\x07";
/** Delay before re-scrolling once pi has laid out a frame with the new content. */
const RETRY_SCROLL_MS = 50;

interface FocusState {
  selected: string | undefined;
  overrides: Map<string, boolean>;
  invalidators: Map<string, () => void>;
  /** Last global expanded state a row rendered with; a change clears overrides. */
  global: boolean | undefined;
  probing: boolean;
  /** The editor's TUI; the feature is only active while it is fullscreen. */
  tui: TUI | undefined;
  /** Width each row's title last rendered at, outside and during a probe. */
  widths: Map<string, number>;
  probeWidths: Map<string, number>;
}

function focus(): FocusState {
  const root = globalThis as Record<symbol, unknown>;
  return (root[STATE] ??= {
    selected: undefined,
    overrides: new Map(),
    invalidators: new Map(),
    global: undefined,
    probing: false,
    tui: undefined,
    widths: new Map(),
    probeWidths: new Map(),
  }) as FocusState;
}

/** Forget the selection and every per-row override (e.g. for a new session). */
export function resetToolFocus(): void {
  const state = focus();
  state.selected = undefined;
  state.overrides.clear();
  state.invalidators.clear();
  state.global = undefined;
  state.probing = false;
  state.widths.clear();
  state.probeWidths.clear();
}

// ---- row side ---------------------------------------------------------------

/** Record the latest redraw callback for a row. */
export function trackToolRow(id: string, invalidate: () => void): void {
  focus().invalidators.set(id, invalidate);
}

/** The row's effective expanded state given pi's global state. */
export function toolRowExpanded(id: string | undefined, globalExpanded: boolean): boolean {
  const state = focus();
  if (state.global !== undefined && state.global !== globalExpanded) state.overrides.clear();
  state.global = globalExpanded;
  if (id === undefined) return globalExpanded;
  return state.overrides.get(id) ?? globalExpanded;
}

/** Selected rows show a marker only while the editor's TUI is fullscreen. */
export function isToolRowSelected(id: string | undefined): boolean {
  const state = focus();
  return id !== undefined && state.selected === id && state.tui !== undefined && isFullscreen(state.tui);
}

/**
 * Called from a row title's render(). Returns an invisible prefix for the
 * title's first line while the editor is probing, and an empty string otherwise.
 */
export function toolRowRendered(id: string | undefined, width: number): string {
  if (id === undefined) return "";
  const state = focus();
  if (!state.probing) {
    state.widths.set(id, width);
    return "";
  }
  state.probeWidths.set(id, width);
  return `${PROBE_PREFIX}${id}${PROBE_SUFFIX}`;
}

// ---- editor side ------------------------------------------------------------

/**
 * Register the editor's TUI. pi hands editors a stable reference that follows
 * regular/fullscreen switches, so the feature turns itself off in regular mode
 * and back on in fullscreen, keeping the selection in between.
 */
export function attachToolFocus(tui: TUI): void {
  focus().tui = tui;
}

/** Only fullscreen can scroll to a row, so tool focus is inactive otherwise. */
function isFullscreen(tui: TUI): boolean {
  const scrollable = tui as unknown as ScrollableTui;
  return scrollable.mode === "fullscreen" && typeof scrollable.scrollBy === "function";
}

/** The subset of pi's fullscreen TUI used for scrolling. */
interface ScrollableTui {
  mode?: string;
  viewportTop?: number;
  scrollBy?: (lines: number) => void;
}

interface LocatedRows {
  /** Row ids in transcript order. */
  order: string[];
  /** Title line offset of each row within the transcript. */
  lines: Map<string, number>;
}

const PROBE_PATTERN = new RegExp(`${escapeRegExp(PROBE_PREFIX)}([^\\x07]*)${escapeRegExp(PROBE_SUFFIX)}`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * pi mounts the transcript document as the TUI's first child in both regular
 * and fullscreen mode. Missing or unrenderable children locate nothing.
 */
function transcript(tui: TUI): Component | undefined {
  const children = (tui as { children?: Component[] }).children;
  return Array.isArray(children) ? children[0] : undefined;
}

function terminalColumns(tui: TUI): number {
  return Math.max(1, (tui as { terminal?: { columns?: number } }).terminal?.columns ?? 80);
}

function locateRows(tui: TUI): LocatedRows {
  const located: LocatedRows = { order: [], lines: new Map() };
  const document = transcript(tui);
  if (!document) return located;

  const state = focus();
  const columns = terminalColumns(tui);
  // Fullscreen may reserve a scrollbar column. Offsets are only right at the
  // width pi rendered the transcript at, which shows as rows' titles probing
  // at the width they last really rendered at.
  for (const width of columns > 1 ? [columns, columns - 1] : [columns]) {
    located.order = [];
    located.lines = new Map();
    state.probeWidths.clear();
    state.probing = true;
    try {
      document.render(width).forEach((line, index) => {
        const id = PROBE_PATTERN.exec(line)?.[1];
        if (id === undefined || located.lines.has(id)) return;
        located.order.push(id);
        located.lines.set(id, index);
      });
    } catch {
      // A component that cannot render outside a frame leaves nothing to select.
    } finally {
      state.probing = false;
    }
    const sample = located.order.find((id) => state.widths.has(id));
    if (sample === undefined || state.widths.get(sample) === state.probeWidths.get(sample)) break;
  }

  for (const map of [state.invalidators, state.widths]) {
    for (const id of map.keys()) {
      if (!located.lines.has(id)) map.delete(id);
    }
  }
  return located;
}

function redraw(ids: Array<string | undefined>): void {
  const state = focus();
  for (const id of new Set(ids)) {
    if (id !== undefined) state.invalidators.get(id)?.();
  }
}

/** Scroll the fullscreen transcript so the row's title line is the top line. */
function scrollToTop(tui: TUI, id: string, retry = true): void {
  const scrollable = tui as unknown as ScrollableTui;
  const top = scrollable.viewportTop;
  if (typeof top !== "number" || typeof scrollable.scrollBy !== "function") return;
  // Re-probe: the selection marker and expansion change line offsets.
  const line = locateRows(tui).lines.get(id);
  if (line === undefined || line === top) return;
  scrollable.scrollBy(line - top);
  // pi clamps to the last frame's content height, so a row that just expanded
  // near the end may only reach the top once the next frame lays it out.
  if (retry && scrollable.viewportTop !== line) {
    setTimeout(() => {
      if (focus().selected === id && isFullscreen(tui)) scrollToTop(tui, id, false);
    }, RETRY_SCROLL_MS).unref?.();
  }
}

/**
 * Move the selection to the previous (-1) or next (+1) tool row. With no live
 * selection, both directions start at the most recent row. Returns whether a
 * row is selected afterwards.
 */
export function moveToolSelection(tui: TUI, direction: -1 | 1): boolean {
  if (!isFullscreen(tui)) return false;
  const { order } = locateRows(tui);
  if (order.length === 0) return false;

  const state = focus();
  const current = state.selected === undefined ? -1 : order.indexOf(state.selected);
  const index = current < 0 ? order.length - 1 : Math.max(0, Math.min(order.length - 1, current + direction));
  const previous = state.selected;
  state.selected = order[index];
  redraw([previous, state.selected]);
  scrollToTop(tui, state.selected!);
  return true;
}

/** Toggle the selected row's expansion. Returns false when nothing is selected. */
export function toggleSelectedTool(tui: TUI): boolean {
  if (!isFullscreen(tui)) return false;
  const state = focus();
  const id = state.selected;
  if (id === undefined || !locateRows(tui).lines.has(id)) return false;
  state.overrides.set(id, !(state.overrides.get(id) ?? state.global ?? false));
  redraw([id]);
  scrollToTop(tui, id);
  return true;
}

/**
 * Clear the selection. Returns false when no row is selected, or the selected
 * row is no longer in the transcript, so the key can fall through.
 */
export function clearToolSelection(tui: TUI): boolean {
  if (!isFullscreen(tui)) return false;
  const state = focus();
  const id = state.selected;
  if (id === undefined) return false;
  state.selected = undefined;
  if (!locateRows(tui).lines.has(id)) return false;
  redraw([id]);
  return true;
}
