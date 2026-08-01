import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "kumo-layout-test-"));
process.env.PI_CODING_AGENT_DIR = stateDir;

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const agentRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const { createJiti } = await import(pathToFileURL(join(agentRoot, "node_modules", "jiti", "lib", "jiti.mjs")));
const agentEntry = join(agentRoot, "dist", "index.js");
const tuiEntry = join(agentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": agentEntry,
    "@earendil-works/pi-tui": tuiEntry,
  },
});

const agent = await import(agentEntry);
const originalToolRender = agent.ToolExecutionComponent.prototype.render;
const originalUserRender = agent.UserMessageComponent.prototype.render;
const originalSelectorRender = agent.ExtensionSelectorComponent.prototype.render;
const originalInputRender = agent.ExtensionInputComponent.prototype.render;
agent.ToolExecutionComponent.prototype.render = function originalToolMarker() {
  return ["ORIGINAL_TOOL"];
};
agent.UserMessageComponent.prototype.render = function originalUserMarker() {
  return ["ORIGINAL_USER"];
};
const DIALOG_RULE = `\x1b[2m${"─".repeat(30)}\x1b[0m`;
agent.ExtensionSelectorComponent.prototype.render = function originalSelectorMarker() {
  return [DIALOG_RULE, "Question?", DIALOG_RULE];
};
agent.ExtensionInputComponent.prototype.render = function originalInputMarker() {
  return [DIALOG_RULE, "Question?", DIALOG_RULE];
};

const handlers = new Map();
const commands = new Map();
let shortcut;
let toolsExpanded = true;
const expansionWrites = [];
const notifications = [];
const pi = {
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  registerShortcut(name, definition) {
    assert.equal(name, "ctrl+k");
    shortcut = definition;
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  registerTool() {
    assert.fail("kumo-layout must not register or override tools");
  },
};

let palette = "dark";
const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const theme = new Proxy({}, {
  get(_target, property) {
    if (property === "fg") return (color, text) => `<${palette}:${color}>${text}</${palette}:${color}>`;
    if (property === "getThinkingBorderColor") {
      return (level) => (text) => `<${palette}:thinking-${level}>${text}</${palette}:thinking-${level}>`;
    }
    return undefined;
  },
});
const realDateNow = Date.now;
let now = 100_000;
Date.now = () => now;

const hiddenThinkingLabelWrites = [];
const ctx = {
  hasUI: true,
  thinkingLevel: "high",
  ui: {
    theme,
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(value) {
      toolsExpanded = value;
      expansionWrites.push(value);
    },
    setHiddenThinkingLabel(label) {
      hiddenThinkingLabelWrites.push(label);
    },
    notify(message) {
      notifications.push(message);
    },
  },
};

try {
  const extension = await jiti.import(join(here, "index.ts"), { default: true });
  extension(pi);

  assert.ok(handlers.has("agent_start"), "agent_start must freeze the previous live group");
  assert.ok(handlers.has("tool_execution_start"));
  assert.ok(handlers.has("tool_execution_update"));
  assert.ok(handlers.has("tool_execution_end"));
  assert.ok(shortcut, "Ctrl+K shortcut must be registered");

  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start");
  assert.deepEqual(expansionWrites, [false], "compact startup must collapse expanded native tool output");
  expansionWrites.length = 0;
  await emit("session_start");
  assert.deepEqual(
    expansionWrites,
    [],
    "compact startup must not rewrite an already-collapsed state or trigger Pi's redundant status row",
  );
  assert.ok(hiddenThinkingLabelWrites.length > 0, "compact startup must set hidden thinking label");
  assert.ok(hiddenThinkingLabelWrites[0].includes("Thinking"), "hidden thinking label must contain Thinking");

  const tool = (toolName, toolCallId, args) => Object.assign(
    Object.create(agent.ToolExecutionComponent.prototype),
    {
      toolName,
      toolCallId,
      args,
      argsComplete: true,
      isPartial: true,
      ui: { requestRender() {} },
    },
  );

  const historical = tool("read", "history", { path: "before-reload.ts" });
  historical.argsComplete = false;
  historical.isPartial = false;
  historical.result = { isError: false };
  const historicalLines = historical.render(160);
  assert.ok(
    historicalLines.join("\n").includes("before-reload.ts"),
    "settled history rebuilt by /reload must remain visible even though Pi does not call setArgsComplete()",
  );
  assert.equal(historicalLines[0], "", "each visible tool block must retain Pi's vertical spacer");
  const incomplete = tool("read", "streaming", { path: "partial" });
  incomplete.argsComplete = false;
  assert.deepEqual(incomplete.render(160), [], "a genuinely streaming call must remain hidden until args complete");

  await emit("tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
  await emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "npm test" } });
  const first = tool("read", "a", { path: "a.ts" });
  const latest = tool("bash", "b", { command: "npm test" });
  assert.deepEqual(first.render(160), [], "only the latest parallel row should render");
  let lines = latest.render(160);
  assert.ok(lines.join("\n").includes("2 tools"));
  assert.ok(lines[1].startsWith(" "), "the parallel group header must keep one leading spacer");
  assert.ok(!lines[1].startsWith("  "), "the parallel group header must keep exactly one leading spacer");
  assert.ok(lines.join("\n").includes("⠋"), "a live parallel group must show a spinner");
  assert.ok(!lines.join("\n").includes("· 0.0s"), "durations below 0.5s must stay hidden");
  now += 499;
  lines = latest.render(160);
  assert.ok(!lines.join("\n").includes("· 0.5s"), "a 499ms duration must stay hidden");
  now += 1;
  lines = latest.render(160);
  assert.ok(lines.join("\n").includes("· 0.5s"), "a 500ms duration must become visible");
  now += 700;
  lines = latest.render(160);
  assert.ok(lines.join("\n").includes("· 1.2s"), "elapsed time must update while tools are running");
  assert.equal(lines[0], "", "a parallel group must have one leading spacer");
  assert.equal(lines.filter((line) => line === "").length, 1, "parallel entries must stay compact inside their group");

  await emit("tool_execution_end", { toolCallId: "a", toolName: "read", isError: false });
  lines = latest.render(160);
  assert.ok(lines.join("\n").includes("⠋"), "the group must keep spinning while a sibling runs");
  latest.isPartial = false;
  latest.result = { isError: false };
  now += 800;
  await emit("tool_execution_end", { toolCallId: "b", toolName: "bash", isError: false });
  lines = latest.render(160);
  assert.ok(lines.join("\n").includes("✓"), "the completed parallel group must settle successfully");
  assert.ok(lines.join("\n").includes("· 1.2s"), "a completed sibling must keep its frozen duration");
  assert.ok(lines.join("\n").includes("· 2.0s"), "the last sibling must show its final duration");

  await emit("agent_start");
  await emit("tool_execution_start", {
    toolCallId: "job",
    toolName: "bash_job",
    args: { action: "wait", jobId: "cmd-1", seconds: 30 },
  });
  const job = tool("bash_job", "job", { action: "wait", jobId: "cmd-1", seconds: 30 });
  lines = job.render(160);
  assert.ok(lines.join("\n").includes("Job"), "compact mode must recognize bash_job");
  assert.ok(lines.join("\n").includes("wait · cmd-1 · 30s"), "bash_job summary must show its action, id, and wait duration");
  job.isPartial = false;
  job.result = { isError: false };
  await emit("tool_execution_end", { toolCallId: "job", toolName: "bash_job", isError: false });
  assert.ok(job.render(160).join("\n").includes("✓"), "bash_job must settle in compact mode");

  await emit("agent_start");
  await emit("tool_execution_start", {
    toolCallId: "search",
    toolName: "parallel_search_web",
    args: { searches: [{ query: "current pi release" }] },
  });
  const search = tool("parallel_search_web", "search", { searches: [{ query: "current pi release" }] });
  lines = search.render(160);
  assert.ok(lines.join("\n").includes("Web Search"), "compact mode must recognize Jina search");
  assert.ok(lines.join("\n").includes("1 query · current pi release"), "Jina search must show query context");
  search.isPartial = false;
  search.result = { isError: false };
  await emit("tool_execution_end", { toolCallId: "search", toolName: "parallel_search_web", isError: false });

  await emit("agent_start");
  await emit("tool_execution_start", {
    toolCallId: "url",
    toolName: "read_url",
    args: { url: "https://example.com/docs", mode: "detailed" },
  });
  const readUrl = tool("read_url", "url", { url: "https://example.com/docs", mode: "detailed" });
  lines = readUrl.render(300);
  assert.ok(lines.join("\n").includes("Read URL"), "compact mode must recognize Jina reader");
  assert.ok(lines.join("\n").includes("https://example.com/docs · detailed"), "Jina reader must show URL and mode");
  readUrl.isPartial = false;
  readUrl.result = { isError: false };
  await emit("tool_execution_end", { toolCallId: "url", toolName: "read_url", isError: false });

  await emit("agent_start");
  await emit("tool_execution_start", { toolCallId: "reqs", toolName: "requirements_list", args: {} });
  const reqs = tool("requirements_list", "reqs", {});
  lines = reqs.render(160);
  assert.ok(lines.join("\n").includes("Requirements list"), "compact mode must recognize requirements_list");
  reqs.isPartial = false;
  reqs.result = { isError: false };
  await emit("tool_execution_end", { toolCallId: "reqs", toolName: "requirements_list", isError: false });
  assert.ok(reqs.render(160).join("\n").includes("✓"), "requirements_list must settle in compact mode");

  for (const [toolName, expectedLabel] of [["subagent", "Subagent"], ["ds_explore_subagent", "DS Scout"]]) {
    await emit("agent_start");
    const id = `agent-${toolName}`;
    const args = { mode: "deep", scope: "both", thinking: "high", task: "Map the relevant implementation and return evidence" };
    await emit("tool_execution_start", { toolCallId: id, toolName, args });
    const component = tool(toolName, id, args);
    await emit("tool_execution_update", {
      toolCallId: id,
      toolName,
      args,
      partialResult: {
        details: {
          activity: "read src/index.ts",
          turns: 3,
          usage: { input: 7420, output: 318 },
        },
      },
    });
    lines = component.render(300);
    assert.equal(lines.length, 4, `${toolName} must render a spacer plus grouped header, activity, and usage rows`);
    assert.ok(lines[1].includes(expectedLabel), `${toolName} must use its compact label`);
    assert.ok(lines[1].includes("[deep/both/high]"), `${toolName} must show its route`);
    assert.ok(lines[2].includes("↳ read src/index.ts"), `${toolName} must stream current activity on its own group row`);
    assert.ok(lines[3].includes("3t ↑7.4k ↓318"), `${toolName} must stream nested token usage on its own group row`);
    component.isPartial = false;
    component.result = { isError: false };
    await emit("tool_execution_end", {
      toolCallId: id,
      toolName,
      isError: false,
      result: { details: { turns: 4, usage: { input: 8100, output: 450 } } },
    });
    lines = component.render(300);
    assert.ok(lines[1].includes("✓"), `${toolName} must settle successfully`);
    assert.ok(lines.join("\n").includes("4t ↑8.1k ↓450"), `${toolName} must show final nested usage`);
  }

  await emit("agent_start");
  await emit("tool_execution_start", { toolCallId: "c", toolName: "ls", args: { path: "." } });
  const nextRun = tool("ls", "c", { path: "." });
  assert.ok(nextRun.render(160).join("\n").includes("List"));
  assert.ok(!nextRun.render(160).join("\n").includes("2 tools"), "agent_start must start a fresh group");

  const user = Object.assign(Object.create(agent.UserMessageComponent.prototype), { text: "hello" });
  const darkUser = user.render(40).join("\n");
  assert.ok(darkUser.includes("<dark:muted>hello"));
  palette = "light";
  const lightUser = user.render(40).join("\n");
  assert.ok(lightUser.includes("<light:muted>hello"), "rendering must use the current theme after invalidation");
  assert.ok(!lightUser.includes("<dark:"));

  // Extension dialogs (ctx.ui.select/input) must recolor their two rules to
  // the thinking-level editor border color in compact mode, content untouched.
  const selectorDialog = Object.create(agent.ExtensionSelectorComponent.prototype);
  const selectorLines = selectorDialog.render(30);
  assert.equal(
    selectorLines[0],
    `<${palette}:thinking-high>${"─".repeat(30)}</${palette}:thinking-high>`,
    "selector dialog rules must match the thinking-level editor border color",
  );
  assert.equal(selectorLines[1], "Question?", "dialog content must stay untouched");
  assert.equal(
    selectorLines[2],
    `<${palette}:thinking-high>${"─".repeat(30)}</${palette}:thinking-high>`,
    "both dialog rules must be recolored",
  );
  const inputDialog = Object.create(agent.ExtensionInputComponent.prototype);
  assert.equal(
    inputDialog.render(30)[0],
    `<${palette}:thinking-high>${"─".repeat(30)}</${palette}:thinking-high>`,
    "input dialog rules must match the thinking-level editor border color",
  );

  const labelCountBeforeToggle = hiddenThinkingLabelWrites.length;
  await shortcut.handler(ctx);
  assert.equal(toolsExpanded, true, "original mode must restore the pre-compact expansion state");
  assert.deepEqual(latest.render(160), ["ORIGINAL_TOOL"]);
  assert.deepEqual(job.render(160), ["ORIGINAL_TOOL"], "original mode must delegate bash_job to Pi's renderer");
  assert.deepEqual(search.render(160), ["ORIGINAL_TOOL"], "original mode must delegate Jina search to Pi's renderer");
  assert.deepEqual(readUrl.render(160), ["ORIGINAL_TOOL"], "original mode must delegate Jina reader to Pi's renderer");
  assert.deepEqual(reqs.render(160), ["ORIGINAL_TOOL"], "original mode must delegate requirements_list to Pi's renderer");
  assert.deepEqual(user.render(40), ["ORIGINAL_USER"]);
  assert.equal(selectorDialog.render(30)[0], DIALOG_RULE, "original mode must keep Pi's dialog border color");
  assert.equal(inputDialog.render(30)[0], DIALOG_RULE, "original mode must keep Pi's input dialog border color");
  assert.equal(JSON.parse(readFileSync(join(stateDir, "kumo-layout.json"), "utf8")).compactMode, false);
  assert.equal(hiddenThinkingLabelWrites[hiddenThinkingLabelWrites.length - 1], undefined, "original mode must restore default hidden thinking label");

  toolsExpanded = false;
  await shortcut.handler(ctx);
  assert.equal(toolsExpanded, false, "re-entering compact mode must collapse native output");
  assert.ok(hiddenThinkingLabelWrites[hiddenThinkingLabelWrites.length - 1]?.includes("Thinking"), "compact mode must set animated thinking label");
  await shortcut.handler(ctx);
  assert.equal(toolsExpanded, false, "original mode must restore an originally collapsed state");
  assert.deepEqual(notifications, [], "layout switching must stay silent");

  agent.initTheme("dark", false);
  await shortcut.handler(ctx); // back to compact mode
  const longThinking = "secret reasoning draft ".repeat(20);
  const assistantMessage = {
    content: [
      { type: "thinking", thinking: longThinking },
      { type: "text", text: "visible answer" },
    ],
  };
  const compactAssistant = new agent.AssistantMessageComponent(assistantMessage, false, undefined, "Thinking...", 0);
  const compactLines = compactAssistant.render(160).join("\n");
  assert.ok(!compactLines.includes(longThinking), "compact mode must hide full thinking content built by updateContent");
  assert.ok(compactLines.includes("Thinking"), "compact mode must show the thinking summary label");
  assert.ok(
    compactLines.includes(`<${palette}:dim>Thinking</${palette}:dim>`),
    "thinking title must use the same dim tone as tool labels",
  );
  assert.ok(compactLines.includes("secret reasoning draft"), "compact label must include a thinking excerpt like tool summaries");
  assert.ok(compactLines.includes("…"), "compact label must ellipsize a long thinking excerpt");
  assert.ok(compactLines.includes("visible answer"), "compact mode must keep assistant text");
  const streamingMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: longThinking }],
  };
  await emit("message_update", { assistantMessageEvent: { type: "thinking_start" }, message: streamingMessage });
  now += 1200;
  streamingMessage.content.push({ type: "text", text: "answer" });
  await emit("message_update", { assistantMessageEvent: { type: "text_start" }, message: streamingMessage });
  const timedAssistant = new agent.AssistantMessageComponent(streamingMessage, false, undefined, "Thinking...", 0);
  assert.ok(timedAssistant.render(160).join("\n").includes("· 1.2s"), "thinking summary must show its duration like tool summaries");
  await emit("agent_start");
  const derivedMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "draft" }],
  };
  await emit("message_update", { message: derivedMessage });
  now += 800;
  derivedMessage.content.push({ type: "text", text: "answer" });
  await emit("message_update", { message: derivedMessage });
  const derivedAssistant = new agent.AssistantMessageComponent(derivedMessage, false, undefined, "Thinking...", 0);
  assert.ok(derivedAssistant.render(160).join("\n").includes("· 0.8s"), "thinking duration must be derivable from message content alone");
  // A new thinking run must not revive settled lines from earlier messages.
  const revivedMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "fresh" }],
  };
  await emit("message_update", { message: revivedMessage });
  const settledLines = new agent.AssistantMessageComponent(streamingMessage, false, undefined, "Thinking...", 0).render(160).join("\n");
  assert.ok(!SPINNER_CHARS.some((frame) => settledLines.includes(frame)), "settled thinking must not spin when a new run starts");
  assert.ok(settledLines.includes("· 1.2s"), "settled thinking must keep its own duration");
  await shortcut.handler(ctx);
  const expandedAssistant = new agent.AssistantMessageComponent(assistantMessage, false, undefined, "Thinking...", 0);
  const expandedText = expandedAssistant.render(160).join("\n");
  assert.ok((expandedText.match(/secret reasoning draft/g) ?? []).length > 5, "original mode must render full thinking content");
  await shortcut.handler(ctx);

  await emit("agent_start");
  await emit("tool_execution_start", {
    toolCallId: "cu",
    toolName: "computer_use",
    args: { method: "get_app_state", app: "com.apple.calculator" },
  });
  const cu = tool("computer_use", "cu", { method: "get_app_state", app: "com.apple.calculator" });
  lines = cu.render(160);
  assert.ok(lines.join("\n").includes("Computer Use"), "compact mode must recognize computer_use");
  assert.ok(lines.join("\n").includes("get_app_state · com.apple.calculator"), "computer_use summary must show method and app");
  cu.isPartial = false;
  cu.result = { isError: false };
  await emit("tool_execution_end", { toolCallId: "cu", toolName: "computer_use", isError: false });
  assert.ok(cu.render(160).join("\n").includes("✓"), "computer_use must settle in compact mode");

  await emit("session_shutdown");

  // ===== user-configurable tool adaptations (no source edits needed) =====
  const layoutCmd = commands.get("kumo-layout");
  assert.ok(layoutCmd, "/kumo-layout command must be registered");
  const configPath = join(stateDir, "kumo-layout.config.json");

  const unknownTool = tool("my_search", "mine", { query: "hello", limit: 3 });
  assert.deepEqual(unknownTool.render(160), ["ORIGINAL_TOOL"], "unconfigured custom tools must keep Pi's original rendering");

  await layoutCmd.handler("add my_search --label \"My Search\" --category Search --summary \"{{args.query}} · {{args.limit}}\"", ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const configured = tool("my_search", "mine", { query: "hello", limit: 3 });
  configured.isPartial = false;
  configured.result = { isError: false };
  let customLines = configured.render(160);
  assert.ok(customLines.join("\n").includes("My Search"), "user config must label a custom tool");
  assert.ok(customLines.join("\n").includes("hello · 3"), "user summary template must resolve args");
  assert.ok(!customLines.join("\n").includes("ORIGINAL_TOOL"), "configured custom tool must use the compact layout");

  await layoutCmd.handler("add partial_tool --label Partial --summary \"{{args.a}} · {{args.b}}\"", ctx);
  const partial = tool("partial_tool", "p1", { a: "only-a" });
  partial.isPartial = false;
  partial.result = { isError: false };
  assert.ok(partial.render(160).join("\n").includes("only-a"), "resolved template segment must show");
  assert.ok(!partial.render(160).join("\n").includes(" · "), "unresolved template segment must drop its separator");

  await layoutCmd.handler("add bash --label Shell2", ctx);
  const shell2 = tool("bash", "b2", { command: "npm test" });
  shell2.isPartial = false;
  shell2.result = { isError: false };
  assert.ok(shell2.render(160).join("\n").includes("Shell2"), "user config must override a built-in label");

  await layoutCmd.handler("add custom_agent --label AgentX --category Agent --agent", ctx);
  await emit("agent_start");
  await emit("tool_execution_start", { toolCallId: "agx", toolName: "custom_agent", args: { task: "do it" } });
  const agentCustom = tool("custom_agent", "agx", { task: "do it" });
  await emit("tool_execution_update", {
    toolCallId: "agx",
    toolName: "custom_agent",
    args: { task: "do it" },
    partialResult: { details: { activity: "working", turns: 2, usage: { input: 100, output: 50 } } },
  });
  const agentLines = agentCustom.render(300);
  assert.ok(agentLines.length >= 3, "custom agent tool must use the grouped layout");
  assert.ok(agentLines.join("\n").includes("AgentX"), "custom agent label must show");
  assert.ok(agentLines.join("\n").includes("working"), "custom agent activity must show");
  assert.ok(agentLines.join("\n").includes("2t ↑100 ↓50"), "custom agent usage must show");

  // Prefix entries adapt any tool whose name starts with the prefix.
  writeFileSync(configPath, JSON.stringify({ version: 1, tools: [{ prefix: "search_", label: "Search", category: "Search", summary: "{{args.query}}" }] }, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const prefixed = tool("search_anything", "px", { query: "find me" });
  prefixed.isPartial = false;
  prefixed.result = { isError: false };
  assert.ok(prefixed.render(160).join("\n").includes("Search"), "prefix config must adapt unknown tools");
  assert.ok(prefixed.render(160).join("\n").includes("find me"), "prefix summary template must resolve args");

  // Result templates evaluate against the tool's result object, so ask-user
  // style tools can echo the user's answer once the call settles.
  await layoutCmd.handler("add ask_user --label Ask --category Ask --summary \"{{args.question}}\" --result \"{{details.answer}}\"", ctx);
  await emit("agent_start");
  await emit("tool_execution_start", { toolCallId: "ask1", toolName: "ask_user", args: { question: "继续吗？" } });
  const ask = tool("ask_user", "ask1", { question: "继续吗？" });
  lines = ask.render(160);
  assert.ok(lines.join("\n").includes("继续吗？"), "a pending ask must show its question");
  assert.ok(!lines.join("\n").includes("→"), "a pending ask must not show a result echo yet");
  ask.isPartial = false;
  ask.result = { isError: false, details: { answer: "继续" } };
  await emit("tool_execution_end", { toolCallId: "ask1", toolName: "ask_user", isError: false, result: { details: { answer: "继续" } } });
  lines = ask.render(160);
  assert.ok(lines.join("\n").includes("✓"), "a settled ask must keep its success mark");
  assert.ok(lines.join("\n").includes("→ 继续"), "a settled ask must echo the user's answer");

  // Settled history rebuilt by /reload carries its recorded result too.
  await emit("agent_start");
  const historicalAsk = tool("ask_user", "ask-hist", { question: "旧问题" });
  historicalAsk.argsComplete = false;
  historicalAsk.isPartial = false;
  historicalAsk.result = { isError: false, details: { answer: "旧答案" } };
  assert.ok(historicalAsk.render(160).join("\n").includes("→ 旧答案"), "settled history must echo the recorded answer");

  // A cancelled ask has no answer; the echo segment must drop quietly.
  await emit("tool_execution_start", { toolCallId: "ask2", toolName: "ask_user", args: { question: "要取消吗" } });
  const cancelledAsk = tool("ask_user", "ask2", { question: "要取消吗" });
  cancelledAsk.isPartial = false;
  cancelledAsk.result = { isError: false, details: { status: "cancelled" } };
  await emit("tool_execution_end", { toolCallId: "ask2", toolName: "ask_user", isError: false, result: { details: { status: "cancelled" } } });
  assert.ok(!cancelledAsk.render(160).join("\n").includes("→"), "a cancelled ask without an answer must not echo");

  // Corrupt user config must never break rendering.
  writeFileSync(configPath, "{ not json", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stillWorks = tool("read", "corrupt", { path: "x.ts" });
  stillWorks.isPartial = false;
  stillWorks.result = { isError: false };
  assert.ok(stillWorks.render(160).join("\n").includes("Read"), "corrupt config must fall back to built-in adaptations");

  await layoutCmd.handler("list", ctx);
  assert.ok(notifications.at(-1).includes("kumo-layout tool adaptations"), "list must print the adaptation table");
  assert.ok(notifications.at(-1).includes("search_*"), "list must show prefix entries");

  await layoutCmd.handler("remove search_", ctx);
  await layoutCmd.handler("reset", ctx);
  assert.ok(!existsSync(configPath), "reset must delete the user config file");

  console.log("kumo-layout regression tests passed");
} finally {
  Date.now = realDateNow;
  agent.ToolExecutionComponent.prototype.render = originalToolRender;
  agent.UserMessageComponent.prototype.render = originalUserRender;
  agent.ExtensionSelectorComponent.prototype.render = originalSelectorRender;
  agent.ExtensionInputComponent.prototype.render = originalInputRender;
  rmSync(stateDir, { recursive: true, force: true });
}
