import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const agentRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const { createJiti } = await import(pathToFileURL(join(agentRoot, "node_modules", "jiti", "lib", "jiti.mjs")));
const agentEntry = join(agentRoot, "dist", "index.js");
const tuiEntry = join(agentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": agentEntry,
    "@earendil-works/pi-tui": tuiEntry,
    typebox: join(agentRoot, "node_modules", "typebox", "build", "index.mjs"),
  },
});

const agent = await import(agentEntry);
const { visibleWidth } = await import(tuiEntry);
const originalFooterRender = agent.FooterComponent.prototype.render;
agent.FooterComponent.prototype.render = function footerMarker() {
  return ["BASE"];
};

function harness(entries = []) {
  const handlers = new Map();
  let stale = false;
  const tools = new Map();
  const renderers = new Map();
  const sent = [];
  const notifications = [];
  const statuses = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    appendEntry() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    registerMessageRenderer(customType, renderer) {
      renderers.set(customType, renderer);
    },
  };
  const ctx = {
    get hasUI() {
      if (stale) throw new Error("stale ctx accessed");
      return true;
    },
    sessionManager: { getEntries: () => entries },
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
      notify: (message, level) => notifications.push({ message, level }),
      setStatus(key, text) {
        statuses.push({ key, text });
      },
    },
  };
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { pi, ctx, tools, renderers, sent, notifications, statuses, emit, markCtxStale: () => { stale = true; } };
}

async function start(entries) {
  const h = harness(entries);
  const extension = await jiti.import(join(here, "index.ts"), { default: true });
  extension(h.pi);
  await h.emit("session_start");
  return h;
}

const footerLines = (width = 80) => agent.FooterComponent.prototype.render.call({}, width);

try {
  // Scenario 1: the hint fires only after 3 untracked tool calls, at most once
  // per user message; a new user message re-arms it; extension input does not.
  {
    const h = await start();
    await h.emit("input", { text: "do work", source: "interactive" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    await h.emit("tool_execution_start", { toolName: "read" });
    assert.equal(h.sent.length, 0, "fewer than 3 tools must not trigger the hint");
    await h.emit("tool_execution_start", { toolName: "edit" });
    assert.equal(h.sent.length, 1, "the 3rd untracked tool must trigger one hint");
    const first = h.sent[0];
    assert.equal(first.message.customType, "requirements-goals", "hints must be custom messages, not user messages");
    assert.equal(first.message.display, false, "hints must not be rendered in the chat panel");
    assert.equal(first.message.details?.kind, "start", "the first hint must be tagged as a start reminder");
    assert.equal(first.options?.deliverAs, "steer", "the hint must be steered into the running turn");
    assert.ok(first.message.content.includes("requirements_add"), "the hint must mention requirements_add");
    await h.emit("tool_execution_start", { toolName: "bash" });
    assert.equal(h.sent.length, 1, "at most one hint per user message");
    await h.emit("input", { text: "more work", source: "interactive" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    assert.equal(h.sent.length, 1, "the tool counter must reset per user message");
    await h.emit("tool_execution_start", { toolName: "read" });
    await h.emit("tool_execution_start", { toolName: "edit" });
    assert.equal(h.sent.length, 2, "a new user message must re-arm the hint after 3 more tools");
    await h.emit("input", { text: "reminder…", source: "extension" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    await h.emit("tool_execution_start", { toolName: "read" });
    await h.emit("tool_execution_start", { toolName: "edit" });
    assert.equal(h.sent.length, 2, "extension-injected input must not re-arm the hint");
    assert.equal(h.notifications.length, 2, "the user must be notified about each hint");
    assert.ok(!h.renderers.has("requirements-goals"), "no message renderer: hints must never appear in the chat");
  }

  // Scenario 1b: a final hint fires at the 20th untracked tool call, then the
  // message gets no more hints; a new user message re-arms the cycle.
  {
    const h = await start();
    await h.emit("input", { text: "big work", source: "interactive" });
    for (let i = 0; i < 19; i++) {
      await h.emit("tool_execution_start", { toolName: "bash" });
    }
    assert.equal(h.sent.length, 1, "only the first hint before the 20th tool call");
    await h.emit("tool_execution_start", { toolName: "bash" });
    assert.equal(h.sent.length, 2, "the 20th untracked tool call must trigger the final hint");
    assert.equal(h.sent[1].options?.deliverAs, "steer", "the final hint must be steered into the running turn");
    assert.equal(h.sent[1].message.details?.kind, "giveUp", "the final hint must be tagged as a give-up reminder");
    assert.ok(h.sent[1].message.content.includes("20 tool calls"), "the final hint must mention the 20-tool threshold");
    await h.emit("tool_execution_start", { toolName: "bash" });
    await h.emit("tool_execution_start", { toolName: "read" });
    assert.equal(h.sent.length, 2, "no further hints after the final one");
    await h.emit("input", { text: "more work", source: "interactive" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    await h.emit("tool_execution_start", { toolName: "read" });
    await h.emit("tool_execution_start", { toolName: "edit" });
    assert.equal(h.sent.length, 3, "a new user message must re-arm the hint cycle");
    await h.emit("tool_execution_start", { toolName: "requirements_add" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    assert.equal(h.sent.length, 3, "tracking must silence further hints in the new cycle");
  }

  // Scenario 2: model tracks before the threshold → no hint.
  {
    const h = await start();
    await h.emit("input", { text: "do work", source: "interactive" });
    await h.emit("tool_execution_start", { toolName: "bash" });
    await h.emit("tool_execution_start", { toolName: "requirements_add" });
    await h.emit("tool_execution_start", { toolName: "read" });
    await h.emit("tool_execution_start", { toolName: "edit" });
    assert.equal(h.sent.length, 0, "tracking before the threshold must suppress the hint");
  }

  // Scenario 3: footer task list + agent_end enforcement.
  {
    const h = await start();
    const add = h.tools.get("requirements_add");
    const result = await add.execute("call-1", { requirements: [{ text: "ship the fix" }] });
    const id = result.details.added[0];
    assert.equal(id, "req-1");
    assert.deepEqual(footerLines(), ["BASE", "<dim>○ ship the fix</dim>"], "pending entries must append after the footer's own lines");
    assert.ok(
      h.statuses.some((s) => s.key === "requirements-goals" && s.text === undefined),
      "every change must nudge the footer to re-render",
    );
    await h.emit("agent_end");
    assert.equal(h.sent.length, 1, "pending requirements must still force a reminder at agent_end");
    assert.equal(h.sent[0].options?.deliverAs, "followUp", "the enforcement reminder must remain a followUp");
    assert.equal(h.sent[0].message.details?.kind, "enforcement", "the enforcement reminder must be tagged as enforcement");
    assert.ok(h.sent[0].message.content.includes("req-1"), "the enforcement reminder must list the pending requirement");
    const update = h.tools.get("requirements_update");
    await update.execute("call-2", { requirements: [{ id, status: "completed" }] });
    assert.deepEqual(footerLines(), ["BASE", "<dim>● ship the fix</dim>"], "a completed requirement must show a solid circle");
    await h.emit("agent_end");
    assert.equal(h.sent.length, 1, "completed requirements must not trigger further reminders");
  }

  // Scenario 4: a new session drops finished requirements and keeps open ones.
  {
    const h = await start([
      {
        type: "custom",
        customType: "requirements-goals",
        data: {
          nextId: 5,
          requirements: [
            { id: "req-1", text: "done task", status: "completed" },
            { id: "req-2", text: "open task", status: "pending" },
            { id: "req-3", text: "paused task", status: "deferred" },
            { id: "req-4", text: "dead task", status: "not_deliverable" },
          ],
        },
      },
    ]);
    assert.deepEqual(
      footerLines(),
      ["BASE", "<dim>○ open task</dim>", "<dim>◎ paused task</dim>"],
      "a new session must only carry over open requirements, deferred shown as a bullseye",
    );
    const list = await h.tools.get("requirements_list").execute("c", {});
    assert.ok(!list.content[0].text.includes("done task"), "completed requirements must be dropped on session start");
    assert.ok(!list.content[0].text.includes("dead task"), "undeliverable requirements must be dropped on session start");
  }

  // Scenario 5: long entries are ANSI-safely truncated to the terminal width.
  {
    const h = await start();
    const longText = "让列表与下载结果表格的列支持拖拽调整顺序".repeat(8);
    await h.tools.get("requirements_add").execute("call-1", { requirements: [{ text: longText }] });
    const width = 82;
    const line = footerLines(width).at(-1);
    assert.ok(visibleWidth(line) <= width, "long entries must not exceed the terminal width");
    assert.ok(line.includes("…"), "truncated entries must show an ellipsis");
  }

  // Scenario 6: a manually cancelled run (Esc) must not trigger the enforcement nudge.
  {
    const h = await start();
    await h.tools.get("requirements_add").execute("call-1", { requirements: [{ text: "left pending" }] });
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
    assert.equal(h.sent.length, 0, "a cancelled run must not trigger the enforcement nudge");
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(h.sent.length, 1, "a normal run with pending requirements must still nudge");
  }

  // Scenario 7: footer renders may race with session replacement. Once shutdown
  // runs, rendering must not touch the old ctx after the runner marks it stale.
  {
    const h = await start();
    await h.tools.get("requirements_add").execute("call-1", { requirements: [{ text: "survives switch" }] });
    await h.emit("session_shutdown", { reason: "resume" });
    h.markCtxStale();
    assert.deepEqual(footerLines(), ["BASE"], "footer must not dereference stale ctx during session replacement");
  }

  // Scenario 8: once the previous task is done and the user types the next
  // message, finished entries leave the footer — display only; the data stays.
  {
    const h = await start();
    const add = h.tools.get("requirements_add");
    const result = await add.execute("call-1", { requirements: [{ text: "old task" }] });
    const id = result.details.added[0];
    await h.tools.get("requirements_update").execute("call-2", { requirements: [{ id, status: "completed" }] });
    assert.deepEqual(footerLines(), ["BASE", "<dim>● old task</dim>"], "finished entries stay pinned while the session is idle");
    await h.emit("input", { text: "follow-up nudge", source: "extension" });
    assert.deepEqual(footerLines(), ["BASE", "<dim>● old task</dim>"], "extension-injected input must not hide finished entries");
    await h.emit("input", { text: "next question", source: "interactive" });
    assert.deepEqual(footerLines(), ["BASE"], "a genuine new user message must hide finished entries from the footer");
    const list = await h.tools.get("requirements_list").execute("call-3", {});
    assert.ok(list.content[0].text.includes("old task"), "hidden entries must remain visible to the model via requirements_list/history");
    await add.execute("call-4", { requirements: [{ text: "new task" }] });
    assert.deepEqual(footerLines(), ["BASE", "<dim>○ new task</dim>"], "new requirements show while previously hidden ones stay hidden");
  }

  console.log("requirements-goals smoke tests passed");
} finally {
  agent.FooterComponent.prototype.render = originalFooterRender;
}
