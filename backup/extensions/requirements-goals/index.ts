import { FooterComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * requirements-goals
 *
 * Registers requirements tracking tools (requirements_add / requirements_update /
 * requirements_list). When the agent ends its run while requirements are still
 * pending (not marked "completed", "not_deliverable", or "deferred"), it sends
 * the unfinished list back and forces another turn so the model keeps working.
 *
 * After each genuine user message, the model's tool calls are counted. If it
 * reaches 3 tool calls without touching any requirements_* tool, the request is
 * treated as a long untracked task and a short hint is steered into the run;
 * if it still has not tracked by 20 tool calls, one final hint is steered in
 * and no further hints are sent for that message. Quick Q&A turns (fewer than
 * 3 tools) are never interrupted. At most two hints per user message;
 * extension-injected input does not re-arm it.
 * If the user cancels a run (Esc), the agent_end enforcement stays silent.
 *
 * Hints are injected as custom messages (pi.sendMessage + customType
 * "requirements-goals") rather than user messages: they still participate in
 * LLM context, but the transcript stays honest (custom_message entries, not
 * fake user input). They are sent with display: false, so nothing appears in
 * the chat panel — the only UI is the ui.notify() toast. pi has no API to
 * send a system-role message; custom messages serialize to the user role in
 * the provider payload.
 *
 * Tracked requirements are appended after the footer's own lines — the very
 * bottom of the screen: ○ pending, ● completed, ◎ deferred, × not_deliverable.
 * Symbols only, footer's dim gray, truncated safely to the terminal width.
 * Once a run has stopped and the user types the next message, entries finished
 * before that input are hidden from the footer — display only: the data, the
 * persisted session entries, and requirements_list keep them, so the model can
 * still see them in history. New sessions drop finished entries entirely.
 */

type Status = "pending" | "completed" | "not_deliverable" | "deferred";

interface Requirement {
  id: string;
  text: string;
  status: Status;
  /** Hidden from the footer after the user moves on; data and history keep it. */
  hidden?: boolean;
}

const MAX_NUDGES = 1;
const HINT_TOOL_THRESHOLD = 3;
const HINT_TOOL_GIVE_UP_THRESHOLD = 20;
const FOOTER_RENDER = Symbol.for("requirements-goals.footer.original-render");
const FOOTER_NUDGE_KEY = "requirements-goals";
const STATUS_MARKS: Record<Status, string> = {
  pending: "○",
  completed: "●",
  deferred: "◎",
  not_deliverable: "×",
};

const START_HINT =
  "Reminder: you have not used the `requirements_add` tool as requested. If that is intentional, ignore this message.";

const GIVE_UP_HINT =
  "Reminder: still no `requirements_add` call after 20 tool calls. If that is intentional, ignore this message — no further reminders for this request.";

export default function (pi: ExtensionAPI) {
  let requirements: Requirement[] = [];
  let nextId = 1;
  let nudgeCount = 0;
  // Start-of-work hint: at most twice per user message (3rd and 20th tool
  // call), after the tool thresholds.
  let startHintGiven = false;
  let hintGiveUp = false;
  let trackingStarted = false;
  let toolsSinceInput = 0;
  // Latest live UI context, so tool execute() can refresh the footer. Footer
  // rendering itself must never dereference this ctx: session replacement marks
  // it stale before the TUI necessarily finishes its final render.
  let activeCtx: ExtensionContext | undefined;
  let dimText: ((text: string) => string) | undefined;

  // Injected hints are custom messages (not fake user input): they still reach
  // the model in LLM context, but are never rendered in the chat (display:
  // false) — the ui.notify() toast is the only UI the user sees.
  const HINT_CUSTOM_TYPE = "requirements-goals";

  function sendHint(kind: "start" | "giveUp" | "enforcement", content: string, deliverAs: "steer" | "followUp") {
    pi.sendMessage(
      { customType: HINT_CUSTOM_TYPE, content, display: false, details: { kind } },
      // triggerTurn restores the sendUserMessage behavior of always starting a
      // new turn once the agent is idle (e.g. the agent_end enforcement).
      { deliverAs, triggerTurn: true },
    );
  }

  function refreshFooter(): void {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    // No dedicated repaint API: clearing an unset status still calls ui.requestRender().
    ctx.ui.setStatus(FOOTER_NUDGE_KEY, undefined);
  }

  // Append the task list after the footer's own lines (pwd / stats / extension
  // statuses) — the very bottom of the screen. The true original render is kept
  // under a global symbol so /reload wraps the original, not our previous patch.
  const footerPrototype = FooterComponent.prototype as unknown as {
    render: (this: unknown, width: number) => string[];
    [FOOTER_RENDER]?: (this: unknown, width: number) => string[];
  };
  if (!footerPrototype[FOOTER_RENDER]) footerPrototype[FOOTER_RENDER] = footerPrototype.render;
  const originalFooterRender = footerPrototype[FOOTER_RENDER];
  footerPrototype.render = function renderFooterWithTasks(this: unknown, width: number): string[] {
    const base = originalFooterRender.call(this, width);
    const renderDim = dimText;
    if (!renderDim) return base;
    const visible = requirements.filter((r) => !r.hidden);
    if (visible.length === 0) return base;
    const taskLines = visible.map((r) => {
      const line = renderDim(`${STATUS_MARKS[r.status]} ${r.text}`);
      // Always pass custom footer rows through Pi TUI's ANSI/CJK-aware
      // truncator. Returning the original string after a separate width check
      // allowed stale rows from a wider render to survive a terminal resize.
      return truncateToWidth(line, Math.max(0, width), "…");
    });
    return [...base, ...taskLines];
  };

  function render() {
    if (requirements.length === 0) return "No requirements tracked.";
    return requirements.map((r) => `- [${r.status}] ${r.id}: ${r.text}`).join("\n");
  }

  function pendingList(): Requirement[] {
    return requirements.filter((r) => r.status === "pending");
  }

  // Restore persisted state after restart / reload
  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    const sessionTheme = ctx.hasUI ? ctx.ui.theme : undefined;
    dimText = sessionTheme ? (text) => sessionTheme.fg("dim", text) : undefined;
    requirements = [];
    nextId = 1;
    nudgeCount = 0;
    startHintGiven = false;
    hintGiveUp = false;
    trackingStarted = false;
    toolsSinceInput = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "requirements-goals") {
        const data = entry.data as { requirements?: Requirement[]; nextId?: number };
        if (Array.isArray(data.requirements)) {
          requirements = data.requirements;
          nextId = data.nextId ?? requirements.length + 1;
        }
      }
    }
    // Finished entries (completed / not_deliverable) do not carry over into a new session.
    const open = requirements.filter((r) => r.status === "pending" || r.status === "deferred");
    if (open.length !== requirements.length) {
      requirements = open;
      pi.appendEntry("requirements-goals", { requirements, nextId });
    }
    refreshFooter();
  });

  pi.on("session_shutdown", () => {
    // Never retain a context beyond its session runtime. The prototype footer
    // can still render briefly while Pi swaps or reloads the session.
    activeCtx = undefined;
    dimText = undefined;
  });

  pi.registerTool({
    name: "requirements_add",
    label: "Requirements Add",
    description:
      "Add user-visible requirements/goals to track for this session. Call this BEFORE starting work, with one entry per independent outcome the user asked for.",
    parameters: Type.Object({
      requirements: Type.Array(
        Type.Object({
          text: Type.String({ description: "One user-visible outcome, independently verifiable" }),
        }),
        { minItems: 1, maxItems: 24 },
      ),
    }),
    async execute(_id, params) {
      const added: Requirement[] = [];
      for (const r of params.requirements) {
        const req: Requirement = { id: `req-${nextId++}`, text: r.text, status: "pending" };
        requirements.push(req);
        added.push(req);
      }
      nudgeCount = 0; // new work arrived; reset reminder budget
      pi.appendEntry("requirements-goals", { requirements, nextId });
      refreshFooter();
      return {
        content: [
          {
            type: "text",
            text: `Added ${added.length} requirement(s):\n${added.map((r) => `${r.id}: ${r.text}`).join("\n")}`,
          },
        ],
        details: { added: added.map((r) => r.id) },
      };
    },
  });

  pi.registerTool({
    name: "requirements_update",
    label: "Requirements Update",
    description:
      "Mark tracked requirements with a final status. Every requirement must reach `completed`, `not_deliverable`, or `deferred` before you finish.\n\n" +
      "- `completed` — the outcome is fully delivered and verified.\n" +
      "- `not_deliverable` — the outcome cannot be delivered at all; state the reason to the user.\n" +
      "- `deferred` — paused, not failed. Use this when you need a decision or answer from the user before you can proceed (ask your question in the same reply), or when it cannot be implemented right now but should not count as a failure. `deferred` does not block ending your turn; when the user replies or conditions change, set it back to `pending` and continue.\n\n" +
      "If you end your turn with any requirement still `pending`, the system will send the pending list back to you and force another turn.",
    parameters: Type.Object({
      requirements: Type.Array(
        Type.Object({
          id: Type.String({ description: "Requirement id, e.g. req-1" }),
          status: Type.Optional(
            Type.Union(
              [
                Type.Literal("pending"),
                Type.Literal("completed"),
                Type.Literal("not_deliverable"),
                Type.Literal("deferred"),
              ],
              { description: "New status" },
            ),
          ),
          text: Type.Optional(Type.String({ description: "Corrected requirement text" })),
        }),
        { minItems: 1, maxItems: 24 },
      ),
    }),
    async execute(_id, params) {
      const results: string[] = [];
      for (const u of params.requirements) {
        const req = requirements.find((r) => r.id === u.id);
        if (!req) {
          results.push(`${u.id}: NOT FOUND`);
          continue;
        }
        if (u.status) req.status = u.status;
        if (u.text) req.text = u.text;
        results.push(`${req.id}: [${req.status}] ${req.text}`);
      }
      pi.appendEntry("requirements-goals", { requirements, nextId });
      refreshFooter();
      return {
        content: [{ type: "text", text: results.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "requirements_list",
    label: "Requirements List",
    description: "List all tracked requirements with their current status.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: render() }], details: {} };
    },
  });

  // Re-arm the start-of-work hint on every genuine user message. Hints injected
  // via pi.sendMessage are custom messages and never fire the input event, so
  // the reminder cannot re-arm itself inside the same turn.
  pi.on("input", (event: { source?: string }) => {
    if (event.source === "extension") return;
    startHintGiven = false;
    hintGiveUp = false;
    trackingStarted = false;
    toolsSinceInput = 0;
    // The previous task stopped and the user moved on: hide finished entries
    // from the footer. Display-only — the data, session entries, and
    // requirements_list keep them, so the model still sees them in history.
    let hidAny = false;
    for (const r of requirements) {
      if (!r.hidden && (r.status === "completed" || r.status === "not_deliverable")) {
        r.hidden = true;
        hidAny = true;
      }
    }
    if (hidAny) {
      pi.appendEntry("requirements-goals", { requirements, nextId });
      refreshFooter();
    }
  });

  // Start-of-work hint: after a user message, count the model's tool calls. Only
  // when it reaches the threshold without tracking — i.e. a long task, not a
  // quick Q&A — steer a short reminder into the run, and one final reminder at
  // the give-up threshold, after which this message gets no more hints.
  pi.on("tool_execution_start", (event: { toolName?: string }, ctx) => {
    if (event.toolName?.startsWith("requirements_")) {
      trackingStarted = true;
      return;
    }
    if (trackingStarted || hintGiveUp) return;
    toolsSinceInput += 1;
    if (toolsSinceInput < HINT_TOOL_THRESHOLD) return;
    if (!startHintGiven) {
      startHintGiven = true;
      sendHint("start", START_HINT, "steer");
      ctx.ui.notify("requirements-goals: steered a reminder to track requirements", "info");
      return;
    }
    if (toolsSinceInput < HINT_TOOL_GIVE_UP_THRESHOLD) return;
    hintGiveUp = true;
    sendHint("giveUp", GIVE_UP_HINT, "steer");
    ctx.ui.notify("requirements-goals: steered a final reminder to track requirements, giving up", "info");
  });

  // Enforcement: if the agent finishes with pending requirements, nudge it back.
  pi.on("agent_end", async (event: { messages?: Array<{ role?: string; stopReason?: string }> }, ctx) => {
    // A manual cancel (Esc) ends the run with an aborted assistant message —
    // never pester the user with the pending list in that case.
    if (event.messages?.some((m) => m.role === "assistant" && m.stopReason === "aborted")) return;
    const pending = pendingList();
    if (pending.length === 0) {
      nudgeCount = 0;
      return;
    }
    if (nudgeCount >= MAX_NUDGES) {
      ctx.ui.notify(
        `requirements-goals: ${pending.length} requirement(s) still pending after ${MAX_NUDGES} reminders; giving up.`,
        "warning",
      );
      return;
    }
    nudgeCount++;
    const list = pending.map((r) => `- ${r.id}: ${r.text}`).join("\n");
    const message =
      "You may not stop yet: the following requirements are still `pending`.\n" +
      "Finish them now; or if one needs user input, mark it `deferred` and ask the user; " +
      "or if it is truly impossible, mark it `not_deliverable` with a reason. " +
      "Then call `requirements_update` before ending your turn.\n\n" +
      "Unfinished requirements:\n" +
      list;
    sendHint("enforcement", message, "followUp");
    ctx.ui.notify(
      `requirements-goals: ${pending.length} pending requirement(s) — sending reminder (${nudgeCount}/${MAX_NUDGES})`,
      "info",
    );
  });
}
