import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  buildContextEntries,
  getMarkdownTheme,
  getSelectListTheme,
  parseSkillBlock,
  sessionEntryToContextMessages,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { isTerminalStatus, type PersistedRunSnapshot } from "./contracts.ts";
import { parseSessionFileStrict } from "./persistence.ts";
import type { RuntimeView, SubagentRuntime } from "./runtime.ts";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? "")).join("");
}

function shortId(id: string): string {
  return id.replace(/^agent-/, "").slice(0, 8);
}

function latestAgentViews(runtime: SubagentRuntime): RuntimeView[] {
  const latest = new Map<string, RuntimeView>();
  for (const view of runtime.views()) {
    const previous = latest.get(view.snapshot.agentId);
    if (!previous || previous.snapshot.runNumber <= view.snapshot.runNumber) latest.set(view.snapshot.agentId, view);
  }
  return [...latest.values()].sort((a, b) => b.snapshot.startedAt.localeCompare(a.snapshot.startedAt));
}

class PickerComponent implements Component {
  private readonly container = new Container();
  constructor(
    views: RuntimeView[],
    theme: Theme,
    tui: TUI,
    done: (agentId: string | undefined) => void,
  ) {
    const list = new SelectList(views.map(({ snapshot }) => ({
      value: snapshot.agentId,
      label: `${snapshot.status.padEnd(11)} ${snapshot.displayName} ${shortId(snapshot.agentId)}`,
      description: snapshot.description,
    })), Math.min(12, Math.max(1, views.length)), getSelectListTheme());
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    this.container.addChild(new Text(theme.fg("toolTitle", theme.bold("Subagents — view only")), 0, 0));
    this.container.addChild(new Text(theme.fg("dim", "Enter: transcript · Escape: close"), 0, 0));
    this.container.addChild(list);
    this.list = list;
    this.tui = tui;
  }
  private readonly list: SelectList;
  private readonly tui: TUI;
  invalidate(): void { this.container.invalidate(); }
  render(width: number): string[] { return this.container.render(width); }
  handleInput(data: string): void { this.list.handleInput(data); this.tui.requestRender(); }
}

interface Expandable extends Component { setExpanded?(expanded: boolean): void }

export class TranscriptViewer implements Component {
  private offset = Number.MAX_SAFE_INTEGER;
  private maxOffset = 0;
  private expanded: boolean;
  private unsubscribe?: () => void;
  private lastError?: string;
  private cachedEntries?: SessionEntry[];
  private seenDurableRevision = -1;

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly snapshot: PersistedRunSnapshot,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    initialExpanded: boolean,
  ) {
    this.expanded = initialExpanded;
    this.seenDurableRevision = runtime.getRunByIds(snapshot.agentId, snapshot.runId)?.durableRevision ?? -1;
    this.unsubscribe = runtime.subscribe(() => {
      const current = runtime.getRunByIds(snapshot.agentId, snapshot.runId);
      if (current && current.durableRevision !== this.seenDurableRevision) {
        this.seenDurableRevision = current.durableRevision;
        this.cachedEntries = undefined;
      }
      const following = this.offset >= this.maxOffset;
      if (following) this.offset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    });
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  invalidate(): void { this.lastError = undefined; }

  private buildComponents(): Component[] {
    const filePath = this.snapshot.childSessionFile;
    if (!filePath) return [new Text(this.theme.fg("error", "Child session file is unavailable"), 0, 0)];
    let entries: SessionEntry[];
    try {
      if (!this.cachedEntries) this.cachedEntries = parseSessionFileStrict(filePath).slice(1) as SessionEntry[];
      entries = this.cachedEntries;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [new Text(this.theme.fg("error", this.lastError), 0, 0)];
    }
    const contextEntries = buildContextEntries(entries);
    const components: Component[] = [];
    const tools = new Map<string, ToolExecutionComponent>();
    const markdownTheme = getMarkdownTheme();
    for (const entry of contextEntries) {
      for (const message of sessionEntryToContextMessages(entry)) {
        if (message.role === "user") {
          const text = messageText(message.content);
          const skill = parseSkillBlock(text);
          if (skill) {
            const component = new SkillInvocationMessageComponent(skill, markdownTheme);
            component.setExpanded(this.expanded);
            components.push(component);
            if (skill.userMessage) components.push(new UserMessageComponent(skill.userMessage, markdownTheme));
          } else if (text) components.push(new UserMessageComponent(text, markdownTheme));
        } else if (message.role === "assistant") {
          components.push(new AssistantMessageComponent(message as AssistantMessage, false, markdownTheme));
          for (const part of message.content) {
            if (part.type !== "toolCall") continue;
            const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, undefined, undefined, this.tui, this.snapshot.cwd);
            tool.markExecutionStarted();
            tool.setArgsComplete();
            tool.setExpanded(this.expanded);
            if (message.stopReason === "aborted" || message.stopReason === "error") {
              tool.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error" }], isError: true });
            } else tools.set(part.id, tool);
            components.push(tool);
          }
        } else if (message.role === "toolResult") {
          const tool = tools.get(message.toolCallId);
          if (tool) tool.updateResult({ content: message.content, details: message.details, isError: message.isError });
          else components.push(new Text(this.theme.fg("muted", `${message.toolName ?? "tool"}: ${messageText(message.content)}`), 0, 0));
        } else if (message.role === "custom") {
          if (!message.display) continue;
          const component = new CustomMessageComponent(message, undefined, markdownTheme);
          component.setExpanded(this.expanded);
          components.push(component);
        } else if (message.role === "bashExecution") {
          const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
          component.appendOutput(message.output);
          component.setComplete(message.exitCode, message.cancelled, message.truncated ? ({ truncated: true } as any) : undefined, message.fullOutputPath);
          component.setExpanded(this.expanded);
          components.push(component);
        } else if (message.role === "branchSummary") {
          const component = new BranchSummaryMessageComponent(message, markdownTheme);
          component.setExpanded(this.expanded);
          components.push(component);
        } else if (message.role === "compactionSummary") {
          const component = new CompactionSummaryMessageComponent(message, markdownTheme);
          component.setExpanded(this.expanded);
          components.push(component);
        } else {
          components.push(new Text(JSON.stringify(message), 0, 0));
        }
      }
    }
    const live = this.runtime.getRunByIds(this.snapshot.agentId, this.snapshot.runId);
    if (live && !isTerminalStatus(live.snapshot.status)) {
      const liveMessage = live.liveMessage as AssistantMessage | undefined;
      if (liveMessage?.role === "assistant") components.push(new AssistantMessageComponent(liveMessage, false, markdownTheme));
      for (const state of live.liveTools ?? []) {
        const tool = new ToolExecutionComponent(state.toolName, state.toolCallId, state.args, undefined, undefined, this.tui, this.snapshot.cwd);
        tool.markExecutionStarted();
        tool.setArgsComplete();
        tool.setExpanded(this.expanded);
        if (state.result) tool.updateResult(state.result, state.partial);
        components.push(tool);
      }
      if (!liveMessage && !(live.liveTools?.length) && live.preview) {
        components.push(new Text(this.theme.fg("warning", `Live: ${live.preview}`), 0, 0));
      }
    }
    if (!components.length) components.push(new Text(this.theme.fg("muted", "(empty child transcript)"), 0, 0));
    return components;
  }

  render(width: number): string[] {
    const current = this.runtime.getRunByIds(this.snapshot.agentId, this.snapshot.runId)?.snapshot ?? this.snapshot;
    const header = truncateToWidth(
      this.theme.fg("toolTitle", this.theme.bold(`${current.displayName} transcript`)) +
        this.theme.fg("dim", ` · ${current.agentId} · ${current.status}`),
      width,
    );
    const help = truncateToWidth(this.theme.fg("dim", "↑↓ PgUp/PgDn Home/End scroll · tool-expand key toggles · Escape closes"), width);
    const body = this.buildComponents().flatMap((component) => component.render(width));
    const height = Math.max(4, this.tui.terminal.rows - 6);
    this.maxOffset = Math.max(0, body.length - height);
    if (this.offset === Number.MAX_SAFE_INTEGER) this.offset = this.maxOffset;
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    return [header, help, ...body.slice(this.offset, this.offset + height)];
  }

  handleInput(data: string): void {
    const height = Math.max(4, this.tui.terminal.rows - 6);
    if (matchesKey(data, Key.escape)) { this.done(); return; }
    if (matchesKey(data, Key.up)) this.offset--;
    else if (matchesKey(data, Key.down)) this.offset++;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.offset -= height;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.offset += height;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
    else if (this.keybindings.matches(data, "app.tools.expand")) this.expanded = !this.expanded;
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    this.tui.requestRender();
  }
}

export class RunningWidget implements Component {
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {
    this.unsubscribe = runtime.subscribe(() => {
      this.scheduleIdleRefresh();
      tui.requestRender();
    });
    this.scheduleIdleRefresh();
  }
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  invalidate(): void {}
  private scheduleIdleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const config = this.runtime.getConfig();
    const views = this.runtime.runningViews();
    if (!config || !views.length) return;
    const now = Date.now();
    const next = Math.min(...views.map((view) => {
      const age = now - new Date(view.snapshot.lastActivityAt ?? view.snapshot.startedAt).getTime();
      return age < config.idleWarningMs ? config.idleWarningMs - age : 1000;
    }));
    this.timer = setTimeout(() => {
      this.tui.requestRender();
      this.scheduleIdleRefresh();
    }, Math.max(1, next));
    this.timer.unref?.();
  }
  render(width: number): string[] {
    const config = this.runtime.getConfig();
    const views = this.runtime.runningViews();
    if (!config || !views.length) return [];
    const now = Date.now();
    const shown = views.slice(0, config.widgetMaxRows).map((view) => {
      const idleMs = now - new Date(view.snapshot.lastActivityAt ?? view.snapshot.startedAt).getTime();
      const idle = idleMs >= config.idleWarningMs ? ` · idle ${Math.round(idleMs / 1000)}s` : "";
      const preview = view.preview ? ` · ${view.preview.replace(/\s+/g, " ")}` : "";
      return truncateToWidth(`${this.theme.fg("warning", "⠹")} ${view.snapshot.displayName} ${view.snapshot.description}${idle}${preview}`, width);
    });
    if (views.length > shown.length) shown.push(this.theme.fg("dim", `… +${views.length - shown.length} more`));
    return shown;
  }
}

async function openViewer(runtime: SubagentRuntime, snapshot: PersistedRunSnapshot, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
    new TranscriptViewer(runtime, snapshot, tui, theme, keybindings, () => done(), ctx.ui.getToolsExpanded()));
}

export function installSubagentUi(runtime: SubagentRuntime, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget("process-subagents", (tui, theme) => new RunningWidget(runtime, tui, theme));
}

export async function showAgents(runtime: SubagentRuntime, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/agents requires the interactive TUI", "warning");
    return;
  }
  const views = latestAgentViews(runtime);
  if (!views.length) {
    ctx.ui.notify("No branch-visible subagents", "info");
    return;
  }
  const agentId = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
    new PickerComponent(views, theme, tui, done));
  if (!agentId) return;
  const selected = runtime.getRun(agentId);
  if (selected) await openViewer(runtime, selected.snapshot, ctx);
}
