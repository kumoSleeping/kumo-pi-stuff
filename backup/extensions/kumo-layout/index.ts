import {
  AssistantMessageComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolSummary = (args: Record<string, unknown>) => string | undefined;
type ToolDisplay = {
  label: string;
  category: string;
  agent: boolean;
  summary: ToolSummary | string;
  result?: string;
};
type UserToolConfig = {
  name?: string;
  prefix?: string;
  label: string;
  category?: string;
  agent?: boolean;
  summary?: string;
  result?: string;
};
type UserConfig = { version?: number; tools?: UserToolConfig[] };

// Built-in adaptations for pi's own tools (including tools that jina-2webtools, bash-jobs,
// requirements-goals and other extensions register under the same names). The
// summary logic lives in argumentSummary(); user config can override any entry
// below or add entirely new names without touching this file.
const builtin = (name: string, label: string, category: string, agent = false) => ({
  name,
  display: { label, category, agent, summary: (args: Record<string, unknown>) => argumentSummary(name, args) } satisfies ToolDisplay,
});
const BUILTIN_TOOLS: Array<{ name: string; display: ToolDisplay }> = [
  builtin("bash", "Shell", "Execute"),
  builtin("bash_job", "Job", "Execute"),
  builtin("parallel_search_web", "Web Search", "Search"),
  builtin("read_url", "Read URL", "Search"),
  builtin("requirements_add", "Requirements add", "Requirements"),
  builtin("requirements_update", "Requirements update", "Requirements"),
  builtin("requirements_list", "Requirements list", "Requirements"),
  builtin("subagent", "Subagent", "Agent", true),
  builtin("ds_explore_subagent", "DS Scout", "Agent", true),
  builtin("read", "Read", "Search"),
  builtin("write", "Write", "Write"),
  builtin("edit", "Edit", "Write"),
  builtin("grep", "Grep", "Search"),
  builtin("find", "Find", "Search"),
  builtin("ls", "List", "Search"),
  builtin("computer_use", "Computer Use", "Desktop"),
];

// User-owned adaptation config lives next to the state file in the pi agent
// directory, so package updates (npm/git) never touch it. Users declare their
// own tool names here; entries override built-ins with the same name and
// prefixes match any tool whose name starts with them.
const CONFIG_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "kumo-layout.config.json");

let configCache: { mtimeMs: number; tools: UserToolConfig[] } | undefined;
function loadUserTools(): UserToolConfig[] {
  try {
    const stat = statSync(CONFIG_PATH, { throwIfNoEntry: false });
    if (!stat) {
      configCache = { mtimeMs: -1, tools: [] };
      return [];
    }
    if (!configCache || configCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as UserConfig;
      const tools = Array.isArray(raw?.tools)
        ? raw.tools.filter((tool): tool is UserToolConfig => (
            typeof tool === "object" && tool !== null
            && typeof tool.label === "string"
            && (typeof tool.name === "string" || typeof tool.prefix === "string")
          ))
        : [];
      configCache = { mtimeMs: stat.mtimeMs, tools };
    }
    return configCache.tools;
  } catch {
    // A corrupt user config must never break rendering: fall back to what we
    // last parsed (or to built-ins only on first load).
    return configCache?.tools ?? [];
  }
}

function makeUserDisplay(config: UserToolConfig): ToolDisplay {
  return {
    label: config.label,
    category: config.category ?? "Tools",
    agent: config.agent ?? false,
    summary: config.summary ?? (() => undefined),
    result: config.result,
  };
}

function displayFor(name: string): ToolDisplay | undefined {
  const userTools = loadUserTools();
  const exact = userTools.find((tool) => tool.name === name);
  if (exact) return makeUserDisplay(exact);
  const prefixes = userTools
    .filter((tool) => tool.prefix && name.startsWith(tool.prefix))
    .sort((a, b) => (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0));
  if (prefixes[0]) return makeUserDisplay(prefixes[0]);
  return BUILTIN_TOOLS.find((tool) => tool.name === name)?.display;
}

function isAdapted(name: string): boolean {
  return displayFor(name) !== undefined;
}

function resolvePath(args: Record<string, unknown>, path: string): unknown {
  if (path.startsWith("count:")) {
    const value = resolvePath(args, path.slice(6));
    return Array.isArray(value) ? value.length : undefined;
  }
  // The "args." prefix is user-facing sugar; lookups start at the args object.
  const keys = path.startsWith("args.") ? path.slice(5).split(".") : path.split(".");
  let current: unknown = args;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return undefined;
  return short(value);
}

// Template syntax: "{{args.path}} · {{args.mode}}". Each " · "-separated
// segment is kept only when every placeholder inside it resolves to a value,
// so optional arguments disappear cleanly. "{{count:args.searches}}" yields
// an array length; "{{args.searches.0.query}}" indexes into arrays.
function evalTemplate(template: string, args: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const segment of template.split(" · ")) {
    const placeholders = [...segment.matchAll(/\{\{([^{}]+)\}\}/g)];
    if (placeholders.length === 0) {
      parts.push(segment);
      continue;
    }
    let resolved = true;
    let output = segment;
    for (const match of placeholders) {
      const value = stringifyValue(resolvePath(args, match[1]));
      if (value === undefined) {
        resolved = false;
        break;
      }
      output = output.replace(match[0], value);
    }
    if (resolved) parts.push(output);
  }
  const text = parts.join(" · ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function summaryFor(name: string, args: Record<string, unknown>): string | undefined {
  const display = displayFor(name);
  if (!display) return short(args);
  return typeof display.summary === "function" ? display.summary(args) ?? undefined : evalTemplate(display.summary, args);
}
const USER_MESSAGE_RENDER = Symbol.for("kumo-layout.user-message.original-render");
const TOOL_EXECUTION_RENDER = Symbol.for("kumo-layout.tool-execution.original-render");
const ASSISTANT_MESSAGE_RENDER = Symbol.for("kumo-layout.assistant-message.original-render");
const ASSISTANT_MESSAGE_UPDATE = Symbol.for("kumo-layout.assistant-message.original-update");
const EXTENSION_SELECTOR_RENDER = Symbol.for("kumo-layout.extension-selector.original-render");
const EXTENSION_INPUT_RENDER = Symbol.for("kumo-layout.extension-input.original-render");
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const STATE_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "kumo-layout.json");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_DOTS = ["", " ·", " ··", " ···", " ····", " ···", " ··", " ·"];

type UserMessageInstance = { text: string };
type ToolProgress = {
  activity?: string;
  turns?: number;
  input?: number;
  output?: number;
  cost?: number;
  model?: string;
  thinking?: string;
};
type ToolResultState = { isError?: boolean; details?: unknown; usage?: unknown };
type ToolUi = { requestRender?: () => void };
type ToolExecutionInstance = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  argsComplete: boolean;
  isPartial: boolean;
  result?: ToolResultState;
  ui?: ToolUi;
};
type AssistantMessageInstance = { hideThinkingBlock: boolean; hiddenThinkingLabel: string };
type AssistantMessagePrototype = RenderPrototype<AssistantMessageInstance> & {
  updateContent: (this: AssistantMessageInstance, message: unknown) => void;
  [ASSISTANT_MESSAGE_UPDATE]?: (this: AssistantMessageInstance, message: unknown) => void;
};
type DialogRenderPrototype = {
  render: (this: unknown, width: number) => string[];
};

type RenderPrototype<T> = {
  render: (this: T, width: number) => string[];
  [USER_MESSAGE_RENDER]?: (this: UserMessageInstance, width: number) => string[];
  [TOOL_EXECUTION_RENDER]?: (this: ToolExecutionInstance, width: number) => string[];
  [ASSISTANT_MESSAGE_RENDER]?: (this: AssistantMessageInstance, width: number) => string[];
};

interface GroupEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "success" | "error";
  startedAt?: number;
  endedAt?: number;
  progress?: ToolProgress;
  result?: unknown;
}

function readCompactMode(): boolean {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { compactMode?: unknown };
    return typeof state.compactMode === "boolean" ? state.compactMode : true;
  } catch {
    return true;
  }
}

function saveCompactMode(compactMode: boolean): void {
  try {
    const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, compactMode }), "utf8");
    renameSync(temporaryPath, STATE_PATH);
  } catch {
    // Persistence is optional; switching still works for the active process.
  }
}

function short(value: unknown, max = 180): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.slice(0, max) + (text.length > max ? "…" : "");
}

function argumentSummary(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return short(args.command);
  if (name === "bash_job") {
    const action = short(args.action, 30);
    const jobId = short(args.jobId, 60);
    const duration = args.action === "wait" && args.seconds !== undefined ? `${short(args.seconds, 20)}s` : "";
    return [action, jobId, duration].filter(Boolean).join(" · ");
  }
  if (name === "parallel_search_web") {
    const searches = Array.isArray(args.searches) ? args.searches : [];
    const noun = searches.length === 1 ? "query" : "queries";
    const first = searches[0] as { query?: unknown } | undefined;
    const query = short(first?.query, 120);
    return [searches.length ? `${searches.length} ${noun}` : "", query].filter(Boolean).join(" · ");
  }
  if (name === "read_url") {
    const mode = typeof args.mode === "string" ? args.mode : "";
    return [short(args.url, 150), mode].filter(Boolean).join(" · ");
  }
  if (name === "requirements_add" || name === "requirements_update") {
    const requirements = Array.isArray(args.requirements) ? args.requirements : [];
    return `${requirements.length} ${requirements.length === 1 ? "item" : "items"}`;
  }
  if (name === "requirements_list") return "";
  if (name === "subagent" || name === "ds_explore_subagent") {
    const route = [args.mode, args.scope, args.thinking].filter(Boolean).map((value) => short(value, 20)).join("/");
    return [route && `[${route}]`, short(args.task, 120)].filter(Boolean).join(" ");
  }
  if (name === "read" || name === "write" || name === "edit") return short(args.path);
  if (name === "grep" || name === "find") {
    return [args.pattern, args.path].filter(Boolean).map((value) => short(value, 90)).join(" · ");
  }
  if (name === "ls") return short(args.path);
  if (name === "computer_use") {
    const method = typeof args.method === "string" ? args.method : "";
    const app = typeof args.app === "string" ? short(args.app, 30) : "";
    return [method, app].filter(Boolean).join(" · ");
  }
  return short(args);
}

function label(name: string): string {
  return displayFor(name)?.label ?? name;
}

function toolCategory(name: string): string {
  return displayFor(name)?.category ?? "Tools";
}

function formatDuration(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  if (clampedMilliseconds < 500) return "";
  const seconds = clampedMilliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatCost(value: number): string {
  if (value <= 0) return "¥0";
  if (value < 0.01) return `¥${value.toFixed(4)}`;
  return `¥${value.toFixed(3)}`;
}

function progressFromResult(value: unknown): ToolProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { details?: unknown; usage?: unknown };
  const details = result.details && typeof result.details === "object"
    ? result.details as Record<string, unknown>
    : {};
  const usageValue = details.usage && typeof details.usage === "object" ? details.usage : result.usage;
  const usage = usageValue && typeof usageValue === "object" ? usageValue as Record<string, unknown> : {};
  const usageCost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
  const progress: ToolProgress = {
    activity: typeof details.activity === "string" ? short(details.activity, 90) : undefined,
    turns: typeof details.turns === "number" ? details.turns : undefined,
    input: typeof usage.input === "number" ? usage.input : undefined,
    output: typeof usage.output === "number" ? usage.output : undefined,
    cost: typeof usageCost.total === "number" && usageCost.total > 0 ? usageCost.total : undefined,
    model: typeof details.model === "string" ? details.model : undefined,
    thinking: typeof details.thinking === "string" ? details.thinking : undefined,
  };
  return Object.values(progress).some((item) => item !== undefined) ? progress : undefined;
}

function isAgentTool(name: string): boolean {
  return displayFor(name)?.agent ?? false;
}

function coloredSummary(theme: Theme, entry: Pick<GroupEntry, "name" | "args" | "startedAt" | "endedAt" | "progress" | "result">): string {
  const argument = summaryFor(entry.name, entry.args);
  // Optional result echo: the config's result template evaluates against the
  // tool's result object (e.g. "{{details.answer}}" for ask-user tools) and is
  // appended once the call has settled. Unresolvable templates stay silent.
  const resultTemplate = displayFor(entry.name)?.result;
  const echo = resultTemplate && entry.result && typeof entry.result === "object"
    ? evalTemplate(resultTemplate, entry.result as Record<string, unknown>)
    : undefined;
  const duration = entry.startedAt === undefined
    ? ""
    : formatDuration((entry.endedAt ?? Date.now()) - entry.startedAt);
  const progress = entry.progress;
  const activity = !isAgentTool(entry.name) && progress?.activity ? `· ${progress.activity}` : "";
  const usage = !isAgentTool(entry.name) && progress && (progress.turns || progress.input || progress.output)
    ? `· ${progress.turns ?? 0}t ↑${formatTokens(progress.input ?? 0)} ↓${formatTokens(progress.output ?? 0)}${progress.cost ? ` ${formatCost(progress.cost)}` : ""}`
    : "";
  return [
    theme.fg("dim", label(entry.name)),
    argument && theme.fg("accent", argument),
    echo && theme.fg("muted", `→ ${short(echo, 100)}`),
    activity && theme.fg("muted", activity),
    usage && theme.fg("dim", usage),
    duration && theme.fg("dim", `· ${duration}`),
  ].filter(Boolean).join(" ");
}

function agentGroupLines(
  theme: Theme,
  entry: Pick<GroupEntry, "name" | "args" | "startedAt" | "endedAt" | "progress">,
  mark: string,
): string[] {
  const lines = [` ${mark} ${coloredSummary(theme, entry)}`];
  if (entry.progress?.activity) lines.push(`   ${theme.fg("muted", `↳ ${entry.progress.activity}`)}`);
  if (entry.progress && (entry.progress.turns || entry.progress.input || entry.progress.output || entry.progress.model)) {
    const usage = `${entry.progress.turns ?? 0}t ↑${formatTokens(entry.progress.input ?? 0)} ↓${formatTokens(entry.progress.output ?? 0)}${entry.progress.cost ? ` ${formatCost(entry.progress.cost)}` : ""}`;
    const identity = entry.progress.model
      ? `${entry.progress.model}${entry.progress.thinking ? `:${entry.progress.thinking}` : ""}`
      : "";
    lines.push(`   ${theme.fg("dim", [usage, identity].filter(Boolean).join(" · "))}`);
  }
  return lines;
}

function entryMark(theme: Theme, entry: Pick<GroupEntry, "status">, spinnerFrame: string): string {
  return entry.status === "running"
    ? theme.fg("dim", spinnerFrame)
    : entry.status === "error"
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
}

function summaryLines(
  theme: Theme,
  entries: Array<Pick<GroupEntry, "name" | "args" | "status" | "startedAt" | "endedAt" | "progress" | "result">>,
  prefix: string,
  spinnerFrame: string,
): string[] {
  if (entries.length === 1) {
    return isAgentTool(entries[0].name)
      ? agentGroupLines(theme, entries[0], prefix)
      : [` ${prefix} ${coloredSummary(theme, entries[0])}`];
  }
  const categories = [...new Set(entries.map((entry) => toolCategory(entry.name)))];
  return [
    ` ${theme.fg("dim", `${categories.join(" & ")} · ${entries.length} tools`)}`,
    ...entries.map((entry) => `   ${entryMark(theme, entry, spinnerFrame)} ${coloredSummary(theme, entry)}`),
  ];
}

function installExtensionDialogLayout(
  getTheme: () => Theme | undefined,
  getThinkingLevel: () => Parameters<Theme["getThinkingBorderColor"]>[0] | undefined,
  isCompact: () => boolean,
): void {
  // Pi frames extension dialogs (ctx.ui.select/input, e.g. ask-user prompts)
  // with two DynamicBorder rules in the default "border" color, while the
  // editor they replace uses the thinking-level border color (borderMuted when
  // no level is selected). Recolor pure-rule lines to match the editor; Pi's
  // own dialogs (model selector etc.) and the original layout stay untouched.
  const recolorRules = (lines: string[]): string[] => {
    const activeTheme = getTheme();
    if (!activeTheme) return lines;
    const thinkingLevel = getThinkingLevel();
    const colorRule = thinkingLevel
      ? activeTheme.getThinkingBorderColor(thinkingLevel)
      : (text: string) => activeTheme.fg("borderMuted", text);
    return lines.map((line) => {
      const plain = line.replace(ANSI_ESCAPE, "");
      return plain.length > 0 && /^─+$/.test(plain) ? colorRule(plain) : line;
    });
  };
  const dialogs: Array<[DialogRenderPrototype, symbol]> = [
    [ExtensionSelectorComponent.prototype as unknown as DialogRenderPrototype, EXTENSION_SELECTOR_RENDER],
    [ExtensionInputComponent.prototype as unknown as DialogRenderPrototype, EXTENSION_INPUT_RENDER],
  ];
  for (const [prototype, key] of dialogs) {
    const originals = prototype as unknown as Record<symbol, ((width: number) => string[]) | undefined>;
    if (!originals[key]) originals[key] = prototype.render;
    prototype.render = function renderDialog(this: unknown, width: number): string[] {
      const lines = originals[key]?.call(this, width) ?? [];
      return isCompact() ? recolorRules(lines) : lines;
    };
  }
}

function installUserMessageLayout(
  getTheme: () => Theme | undefined,
  getThinkingLevel: () => Parameters<Theme["getThinkingBorderColor"]>[0] | undefined,
  isCompact: () => boolean,
): void {
  const prototype = UserMessageComponent.prototype as unknown as RenderPrototype<UserMessageInstance>;
  if (!prototype[USER_MESSAGE_RENDER]) prototype[USER_MESSAGE_RENDER] = prototype.render;

  prototype.render = function renderUserMessage(this: UserMessageInstance, width: number): string[] {
    const original = prototype[USER_MESSAGE_RENDER];
    const activeTheme = getTheme();
    if (!isCompact() || !activeTheme || width < 12) return original?.call(this, width) ?? [];

    const wrapped = wrapTextWithAnsi(this.text ?? "", Math.max(1, width));
    const messageLines = wrapped.map((line: string) => activeTheme.fg("muted", line));
    const thinkingLevel = getThinkingLevel();
    const colorRule = thinkingLevel
      ? activeTheme.getThinkingBorderColor(thinkingLevel)
      : (text: string) => activeTheme.fg("borderMuted", text);
    const rule = colorRule("─".repeat(width));
    const lines = ["", rule, ...messageLines, rule];
    lines[1] = OSC133_ZONE_START + lines[1];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    return lines;
  };
}

function installToolExecutionLayout(options: {
  getTheme: () => Theme | undefined;
  isCompact: () => boolean;
  isLatest: (id: string) => boolean;
  getGroup: (id: string) => GroupEntry[];
  registerComponent: (id: string, component: ToolExecutionInstance) => void;
  getSpinnerFrame: () => string;
}): void {
  const prototype = ToolExecutionComponent.prototype as unknown as RenderPrototype<ToolExecutionInstance>;
  if (!prototype[TOOL_EXECUTION_RENDER]) prototype[TOOL_EXECUTION_RENDER] = prototype.render;

  prototype.render = function renderToolExecution(this: ToolExecutionInstance, width: number): string[] {
    const original = prototype[TOOL_EXECUTION_RENDER];
    if (!options.isCompact() || !isAdapted(this.toolName)) return original?.call(this, width) ?? [];

    const activeTheme = options.getTheme();
    if (!activeTheme || width < 8) return original?.call(this, width) ?? [];

    const id = this.toolCallId ?? "";
    options.registerComponent(id, this);
    const group = options.getGroup(id);
    // Pi does not call setArgsComplete() when rebuilding settled tool rows from
    // session history (including /reload). A finalized result is sufficient
    // evidence that its persisted arguments are complete. Keep suppressing a
    // genuinely streaming call until message_end marks its args complete.
    const isSettledHistory = group.length === 0 && this.result !== undefined && !this.isPartial;
    if ((!this.argsComplete && !isSettledHistory) || (id && !options.isLatest(id))) return [];

    const fallbackStatus = this.isPartial
      ? "running"
      : this.result?.isError
        ? "error"
        : "success";
    const shown: GroupEntry[] = group.length
      ? group
      : [{ id, name: this.toolName, args: this.args ?? {}, status: fallbackStatus, result: this.result }];
    const running = shown.some((entry) => entry.status === "running");
    const failed = shown.some((entry) => entry.status === "error");
    const mark = running
      ? activeTheme.fg("dim", options.getSpinnerFrame())
      : failed
        ? activeTheme.fg("error", "✗")
        : activeTheme.fg("success", "✓");

    return [
      "",
      ...summaryLines(activeTheme, shown, mark, options.getSpinnerFrame()).map((line) => truncateToWidth(line, width, "…")),
    ];
  };
}

function installAssistantMessageLayout(
  isCompact: () => boolean,
  makeLabel: (excerpt: string | undefined, width: number, message: unknown) => string,
): void {
  const prototype = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
  if (!prototype[ASSISTANT_MESSAGE_UPDATE]) prototype[ASSISTANT_MESSAGE_UPDATE] = prototype.updateContent;

  // Thinking content is built in updateContent(), not render(), so hiding must
  // happen here: temporarily force the hidden state while the original builder runs,
  // with a tool-style one-line summary (excerpt + duration) as the label.
  prototype.updateContent = function updateAssistantContent(this: AssistantMessageInstance, message: unknown): void {
    const original = prototype[ASSISTANT_MESSAGE_UPDATE];
    if (!isCompact()) {
      original?.call(this, message);
      return;
    }
    const content = (message as { content?: Array<{ type: string; thinking?: string }> })?.content;
    const rawThinking = content
      ?.filter((block) => block.type === "thinking")
      .map((block) => block.thinking?.trim())
      .filter(Boolean)
      .join(" ") ?? "";
    const collapsed = rawThinking.replace(/\s+/g, " ").trim();
    // Strip inline markdown markers so **bold**, *italic* and `code` read as plain text.
    const plain = collapsed
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]*)`/g, "$1");
    const width = Math.max(24, (process.stdout.columns ?? 80) - 2);
    const excerpt = plain || undefined;
    const savedHide = this.hideThinkingBlock;
    const savedLabel = this.hiddenThinkingLabel;
    this.hideThinkingBlock = true;
    this.hiddenThinkingLabel = makeLabel(excerpt, width, message);
    original!.call(this, message);
    this.hideThinkingBlock = savedHide;
    this.hiddenThinkingLabel = savedLabel;
  };
}

export default function kumoLayout(pi: ExtensionAPI) {
  let activeTheme: Theme | undefined;
  let activeThinkingLevel: Parameters<Theme["getThinkingBorderColor"]>[0] | undefined;
  let compactMode = readCompactMode();
  // Published for other extensions (e.g. requirements-goals) so their custom
  // message renderers can switch to Kumo's one-line tool-row style.
  const COMPACT_FLAG = Symbol.for("kumo-layout.compact-mode");
  (globalThis as Record<symbol, unknown>)[COMPACT_FLAG] = compactMode;
  let originalToolsExpanded: boolean | undefined;
  let entries: GroupEntry[] = [];
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let thinkingDotsFrame = 0;
  let thinkingDotsTimer: ReturnType<typeof setInterval> | undefined;
  // Per-message thinking timing, so a new thinking run never revives old settled lines.
  const thinkingTimes = new WeakMap<object, { startedAt: number; endedAt?: number }>();
  let activeThinkingMessage: object | undefined;
  type Timer = NonNullable<typeof spinnerTimer>;
  const byId = new Map<string, GroupEntry[]>();
  const components = new Map<string, ToolExecutionInstance>();

  const isLatest = (id: string) => {
    const group = byId.get(id);
    return !group || group.at(-1)?.id === id;
  };
  const getGroup = (id: string) => byId.get(id) ?? [];
  const requestGroupRender = (group: GroupEntry[] = entries) => {
    const latest = group.at(-1);
    if (latest) components.get(latest.id)?.ui?.requestRender?.();
  };
  const stopSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };
  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (compactMode) requestGroupRender();
    }, 100);
    (spinnerTimer as Timer).unref?.();
  };
  const stopThinkingDots = () => {
    if (thinkingDotsTimer) clearInterval(thinkingDotsTimer);
    thinkingDotsTimer = undefined;
  };
  const startThinkingDots = (ctx: ExtensionContext) => {
    if (thinkingDotsTimer || !compactMode) return;
    thinkingDotsTimer = setInterval(() => {
      thinkingDotsFrame = (thinkingDotsFrame + 1) % SPINNER_FRAMES.length;
      const animatedLabel = `${SPINNER_FRAMES[thinkingDotsFrame]} Thinking`;
      ctx.ui.setHiddenThinkingLabel(activeTheme ? activeTheme.fg("dim", animatedLabel) : animatedLabel);
    }, 100);
    (thinkingDotsTimer as Timer).unref?.();
  };
  const freeze = () => {
    entries = [];
    stopSpinner();
    stopThinkingDots();
  };

  installUserMessageLayout(() => activeTheme, () => activeThinkingLevel, () => compactMode);
  installExtensionDialogLayout(() => activeTheme, () => activeThinkingLevel, () => compactMode);
  installToolExecutionLayout({
    getTheme: () => activeTheme,
    isCompact: () => compactMode,
    isLatest,
    getGroup,
    registerComponent: (id, component) => {
      if (!id) return;
      components.set(id, component);
      const entry = byId.get(id)?.find((item) => item.id === id);
      if (entry) entry.args = component.args ?? entry.args;
    },
    getSpinnerFrame: () => SPINNER_FRAMES[spinnerFrame],
  });
  installAssistantMessageLayout(() => compactMode, (excerpt, width, message) => {
    const record = message && typeof message === "object" ? thinkingTimes.get(message as object) : undefined;
    const running = !!record && record.endedAt === undefined;
    const duration = record?.endedAt !== undefined ? formatDuration(record.endedAt - record.startedAt) : "";
    const spinner = activeTheme
      ? activeTheme.fg("dim", SPINNER_FRAMES[thinkingDotsFrame % SPINNER_FRAMES.length])
      : SPINNER_FRAMES[thinkingDotsFrame % SPINNER_FRAMES.length];
    const mark = running ? spinner : "";
    const title = "Thinking";
    const coloredTitle = activeTheme ? activeTheme.fg("dim", title) : title;
    const fixed = (mark ? 2 : 0) + title.length + (duration ? duration.length + 2 : 0);
    let clipped: string | undefined;
    if (excerpt) {
      const budget = Math.max(0, width - fixed - 1);
      // truncateToWidth accounts for East Asian double-width characters.
      // Ellipsis is appended after coloring so it stays in the default color,
      // matching how truncated tool summaries render their "…".
      const truncated = truncateToWidth(excerpt, budget, "") !== excerpt;
      const text = truncated ? truncateToWidth(excerpt, Math.max(0, budget - 1), "") : excerpt;
      clipped = `${activeTheme ? activeTheme.fg("dim", text) : text}${truncated ? "…" : ""}`;
    }
    const tail = duration ? (activeTheme ? activeTheme.fg("dim", `· ${duration}`) : `· ${duration}`) : "";
    return [
      mark,
      coloredTitle,
      clipped,
      tail,
    ].filter(Boolean).join(" ");
  });

  const setCompactMode = (compact: boolean, ctx: ExtensionContext) => {
    const wasCompact = compactMode;
    compactMode = compact;
    (globalThis as Record<symbol, unknown>)[COMPACT_FLAG] = compact;
    if (!ctx.hasUI) return;

    if (compact) {
      if (!wasCompact || originalToolsExpanded === undefined) originalToolsExpanded = ctx.ui.getToolsExpanded();
      // Pi's setter also prints a transient "Tool output: collapsed" row.
      // Avoid calling it when output is already collapsed (the normal startup
      // state), so enabling Kumo layout does not add that redundant message.
      if (ctx.ui.getToolsExpanded()) ctx.ui.setToolsExpanded(false);
      const idleLabel = `Thinking${THINKING_DOTS[thinkingDotsFrame]}`;
      ctx.ui.setHiddenThinkingLabel(activeTheme ? activeTheme.fg("dim", idleLabel) : idleLabel);
      if (entries.some((entry) => entry.status === "running")) startSpinner();
    } else {
      stopSpinner();
      stopThinkingDots();
      ctx.ui.setToolsExpanded(originalToolsExpanded ?? ctx.ui.getToolsExpanded());
      ctx.ui.setHiddenThinkingLabel();
      originalToolsExpanded = undefined;
    }
  };

  pi.registerShortcut("ctrl+k", {
    description: "Toggle Kumo and original conversation layouts",
    handler: async (ctx) => {
      setCompactMode(!compactMode, ctx);
      saveCompactMode(compactMode);
    },
  });

  const writeUserConfig = (tools: UserToolConfig[]): boolean => {
    try {
      const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, tools }, null, 2), "utf8");
      renameSync(temporaryPath, CONFIG_PATH);
      configCache = undefined;
      return true;
    } catch {
      return false;
    }
  };
  const tokenize = (input: string): string[] =>
    (input.match(/"[^"]*"|\S+/g) ?? []).map((token) =>
      token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
    );
  pi.registerCommand("kumo-layout", {
    description: "Manage custom tool adaptations for the compact layout",
    handler: async (rawArgs, ctx) => {
      const tokens = tokenize(rawArgs ?? "");
      const [command, ...rest] = tokens;
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (!token.startsWith("--")) continue;
        const name = token.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = "true";
        }
      }
      const current = loadUserTools();
      const save = (tools: UserToolConfig[]): string =>
        writeUserConfig(tools) ? "saved to kumo-layout.config.json" : `ERROR: could not write ${CONFIG_PATH}`;
      switch (command) {
        case "list": {
          const rows = ["kumo-layout tool adaptations (built-in + user config):"];
          for (const { name, display } of BUILTIN_TOOLS) {
            const overridden = current.some((tool) => tool.name === name);
            rows.push(`  ${overridden ? "override" : "built-in "}  ${name.padEnd(24)} ${display.label.padEnd(16)} ${display.category}`);
          }
          for (const tool of current) {
            if (tool.name && !BUILTIN_TOOLS.some((entry) => entry.name === tool.name)) {
              rows.push(`  user      ${tool.name.padEnd(24)} ${tool.label.padEnd(16)} ${tool.category ?? "Tools"}${tool.agent ? "  [agent]" : ""}${tool.result ? "  [→result]" : ""}`);
            }
            if (tool.prefix) {
              rows.push(`  prefix    ${(tool.prefix + "*").padEnd(24)} ${tool.label.padEnd(16)} ${tool.category ?? "Tools"}${tool.agent ? "  [agent]" : ""}${tool.result ? "  [→result]" : ""}`);
            }
          }
          ctx.ui.notify(rows.join("\n"), "info");
          return;
        }
        case "add": {
          const name = flags.name ?? tokens[1];
          const prefix = flags.prefix;
          if (!name && !prefix) {
            ctx.ui.notify("Usage: /kumo-layout add <name> --label <label> [--category <cat>] [--summary \"{{args.x}}\"] [--result \"{{details.x}}\"] [--agent] [--prefix <p>]", "error");
            return;
          }
          if (!flags.label) {
            ctx.ui.notify("--label is required", "error");
            return;
          }
          const entry: UserToolConfig = {
            ...(name ? { name } : {}),
            ...(prefix ? { prefix } : {}),
            label: flags.label,
            ...(flags.category ? { category: flags.category } : {}),
            ...(flags.summary ? { summary: flags.summary } : {}),
            ...(flags.result ? { result: flags.result } : {}),
          };
          if (flags.agent === "true") entry.agent = true;
          const index = current.findIndex((tool) => (name ? tool.name === name : tool.prefix === prefix));
          if (index >= 0) current[index] = entry;
          else current.push(entry);
          ctx.ui.notify(`${name ?? `${prefix}*`} → ${save(current)}`, "info");
          return;
        }
        case "remove": {
          const name = tokens[1] ?? flags.name;
          if (!name) {
            ctx.ui.notify("Usage: /kumo-layout remove <name>", "error");
            return;
          }
          if (!current.some((tool) => tool.name === name || tool.prefix === name)) {
            if (BUILTIN_TOOLS.some((entry) => entry.name === name)) {
              ctx.ui.notify(`${name} is built-in; override it with /kumo-layout add ${name} --label ... instead`, "error");
            } else {
              ctx.ui.notify(`${name} is not configured`, "error");
            }
            return;
          }
          save(current.filter((tool) => tool.name !== name && tool.prefix !== name));
          ctx.ui.notify(`removed ${name}`, "info");
          return;
        }
        case "reset": {
          try {
            unlinkSync(CONFIG_PATH);
          } catch {
            // No config file to remove.
          }
          configCache = undefined;
          ctx.ui.notify("removed kumo-layout.config.json; built-in adaptations remain", "info");
          return;
        }
        default:
          ctx.ui.notify(
            "Usage: /kumo-layout list | add <name> --label <label> [--category <cat>] [--summary \"{{args.x}}\"] [--result \"{{details.x}}\"] [--agent] [--prefix <p>] | remove <name> | reset",
            "error",
          );
      }
    },
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    entries = [];
    byId.clear();
    components.clear();
    stopSpinner();
    stopThinkingDots();
    activeTheme = ctx.ui.theme;
    activeThinkingLevel = ctx.thinkingLevel;
    setCompactMode(compactMode, ctx);
  });
  pi.on("session_shutdown", () => {
    stopSpinner();
    stopThinkingDots();
    components.clear();
    freeze();
  });
  pi.on("thinking_level_select", (event: { level: Parameters<Theme["getThinkingBorderColor"]>[0] }) => {
    activeThinkingLevel = event.level;
  });
  const endThinking = () => {
    const record = activeThinkingMessage && thinkingTimes.get(activeThinkingMessage);
    if (record && record.endedAt === undefined) record.endedAt = Date.now();
  };
  pi.on("tool_execution_start", (event: { toolCallId: string; toolName: string; args: unknown }) => {
    endThinking();
    if (!isAdapted(event.toolName)) return;
    const previous = entries.at(-1);
    const entry: GroupEntry = {
      id: event.toolCallId,
      name: event.toolName,
      args: event.args as Record<string, unknown>,
      status: "running",
      startedAt: Date.now(),
    };
    entries.push(entry);
    byId.set(entry.id, entries);
    if (compactMode) startSpinner();
    if (previous) components.get(previous.id)?.ui?.requestRender?.();
  });
  pi.on("tool_execution_update", (event: { toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }) => {
    if (!isAdapted(event.toolName)) return;
    const group = byId.get(event.toolCallId);
    const entry = group?.find((item) => item.id === event.toolCallId);
    if (!group || !entry) return;
    if (event.args && typeof event.args === "object") entry.args = event.args as Record<string, unknown>;
    entry.progress = progressFromResult(event.partialResult) ?? entry.progress;
    requestGroupRender(group);
  });
  pi.on("tool_execution_end", (event: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }) => {
    if (!isAdapted(event.toolName)) return;
    const group = byId.get(event.toolCallId);
    const entry = group?.find((item) => item.id === event.toolCallId);
    if (!group || !entry) return;
    entry.status = event.isError ? "error" : "success";
    entry.endedAt = Date.now();
    entry.result = event.result ?? entry.result;
    entry.progress = progressFromResult(event.result) ?? entry.progress;
    if (!group.some((item) => item.status === "running")) stopSpinner();
    requestGroupRender(group);
  });
  const onMessageUpdate = pi.on as unknown as (
    event: "message_update",
    handler: (event: { assistantMessageEvent?: { type: string }; message?: { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> } }, ctx: ExtensionContext) => void,
  ) => void;
  onMessageUpdate("message_update", (event, ctx) => {
    // Derive thinking timing from the message content itself, so it works even if
    // specific assistantMessageEvent types are not forwarded to extensions.
    const message = event.message?.role === "assistant" ? event.message : undefined;
    const content = message?.content ?? [];
    const hasThinking = content.some((block) => block.type === "thinking" && block.thinking?.trim());
    const hasTextAfter = content.some((block) => block.type === "text" && block.text?.trim());
    const hasToolCall = content.some((block) => block.type === "toolCall");
    if (message && hasThinking) {
      let record = thinkingTimes.get(message);
      if (!record) {
        record = { startedAt: Date.now() };
        thinkingTimes.set(message, record);
      }
      activeThinkingMessage = message;
      if (hasTextAfter || hasToolCall) {
        if (record.endedAt === undefined) record.endedAt = Date.now();
        stopThinkingDots();
      } else if (compactMode) {
        startThinkingDots(ctx);
      }
    }
    if (event.assistantMessageEvent?.type === "thinking_start") {
      freeze();
      if (compactMode) startThinkingDots(ctx);
    } else if (event.assistantMessageEvent?.type === "text_start" || event.assistantMessageEvent?.type === "thinking_end") {
      stopThinkingDots();
      freeze();
    }
  });
  pi.on("message_end", (event: { message?: { role?: string } }) => {
    const message = event.message?.role === "assistant" ? event.message : undefined;
    const record = message && thinkingTimes.get(message);
    if (record && record.endedAt === undefined) record.endedAt = Date.now();
    stopThinkingDots();
  });
  pi.on("agent_start", () => {
    freeze();
    activeThinkingMessage = undefined;
  });
}
