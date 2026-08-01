/**
 * Ask User — non-blocking user input tools.
 *
 * Mirrors the bash/bash_job handoff pattern from the bash-jobs extension:
 *   - user_input      opens a dialog immediately and returns the answer if the
 *                     user responds within the grace window, otherwise hands
 *                     off with a request ID (ask-N)
 *   - user_input_wait waits for, inspects, or cancels the pending question
 *
 * Mixed-mode dialogs (single mode, no select-vs-input split): fixed
 * quick-pick options and free-text input are always BOTH available. The
 * options array order IS the presentation order — the model passes its
 * options in the order they should appear. An input line is always shown
 * below the options and focused from the start: type right away, Enter to
 * submit, ↑ to go back to the options. Free input is always available. If
 * the user answers after the 1-minute handoff and the model did not collect the
 * answer, it is pushed to the model as a custom message (invisible in chat,
 * like requirements-goals' sendHint).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, getKeybindings, Input, Spacer, Text, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const HANDOFF_AFTER_SECONDS = 60;
const MAX_WAIT_SECONDS = 86_400;
const STOP_WAIT_MS = 3_000;
const MAX_RETAINED_ASKS = 20;
const ASK_RETENTION_MS = 60 * 60 * 1_000;
// When the user answers after the 1-minute handoff and the model has not collected
// the answer via user_input_wait, push it as a custom message so the model can
// continue with it.
const ANSWER_PUSH_DELAY_MS = 5_000;
// Appended to wait returns that keep coming back still-pending: the user may
// be away, so continue if possible instead of polling forever.
const AWAY_HINT = "User may be away: continue if you can, pause if you can't.";

type AskStatus = "pending" | "answered" | "cancelled" | "failed";

type ThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];

// Kumo Layout publishes its compact-mode flag for other extensions; when it
// is active, dialog borders follow the current thinking-level color, exactly
// like Kumo recolors Pi's own extension dialogs.
function dialogBorderRule(
  theme: Theme,
  thinkingLevel: ThinkingLevel | undefined,
): ((s: string) => string) | undefined {
  const compact = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for("kumo-layout.compact-mode")]);
  if (!compact) return undefined; // default border color
  return thinkingLevel
    ? theme.getThinkingBorderColor(thinkingLevel)
    : (s: string) => theme.fg("borderMuted", s);
}

type AskRequest = {
  id: string;
  question: string;
  options: string[];
  status: AskStatus;
  answer: string | null;
  source: "option" | "free-text" | null;
  error?: string;
  startedAt: number;
  completion: Promise<void>;
  finish: () => void;
  abort: AbortController;
  cancelRequested: boolean;
  finalized: boolean;
  pendingReturns: number;
  delivered: boolean;
  pushTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
};

const askSchema = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Fixed choices in presentation order (array order = display order); a free-input entry is always appended at the end. Omit for pure free-text input.",
    }),
  ),
  placeholder: Type.Optional(Type.String({ description: "Placeholder for the free-text input box" })),
  timeout: Type.Optional(
    Type.Number({
      minimum: 5,
      maximum: 3600,
      description: "Auto-dismiss the dialog after this many seconds (default: no timeout)",
    }),
  ),
});

const askWaitSchema = Type.Object({
  action: StringEnum(["wait", "status", "cancel"] as const, {
    description: "wait for the user's answer, inspect status immediately, or cancel the prompt",
  }),
  requestId: Type.String({ description: "Request ID returned by user_input" }),
  seconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_WAIT_SECONDS,
      description: "Seconds to wait (required for action=wait); choose based on expected response time",
    }),
  ),
});

function askIsFinal(request: AskRequest): boolean {
  return request.status !== "pending";
}

function askElapsed(request: AskRequest): string {
  return ((Date.now() - request.startedAt) / 1000).toFixed(1);
}

async function waitForAsk(request: AskRequest, milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (request.finalized || milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    void request.completion.then(finish);
  });
}

function askStatusText(request: AskRequest): string {
  switch (request.status) {
    case "pending":
      return `Still waiting for the user to answer "${request.question}" (${askElapsed(request)}s elapsed).`;
    case "answered":
      return `User answered: ${request.answer ?? ""}`;
    case "cancelled":
      return request.cancelRequested
        ? "Prompt cancelled via user_input_wait."
        : "User cancelled the prompt (Esc).";
    case "failed":
      return `Prompt failed: ${request.error ?? "unknown error"}`;
  }
}

type DialogResult = { answer: string | undefined; source: "option" | "free-text" };

type PickResult = { type: "option" | "custom"; value: string };

/**
 * Input line that doubles as the last selectable row. The selection arrow
 * follows it: while selected the Input's own "> " prompt acts as the marker
 * (aligned with the option rows), replacing the placeholder immediately — no
 * typing needed. While unselected it shows a grey "[Custom Input]"
 * placeholder. No reverse-video cursor blocks; only the hardware cursor
 * marker is emitted for IME anchoring.
 */
class PaddedInput implements Component, Focusable {
  private readonly inner = new Input();
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  getValue(): string {
    return this.inner.getValue();
  }

  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(value: boolean) {
    this.inner.focused = value;
  }

  handleInput(data: string): void {
    // Always feed the editor (IME / paste / editing keys).
    this.inner.handleInput(data);
    this.inner.invalidate();
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    if (!this.focused) {
      // Unselected: grey placeholder, aligned with the option text column.
      return [`   ${this.theme.fg("dim", "[Custom Input]")}`];
    }
    if (this.inner.getValue().length === 0) {
      // Selected but empty: the "> " selection marker plus the hardware
      // cursor marker only — no reverse-video block. The extra space keeps
      // the cursor at the option text column (option rows carry a 1-col
      // Text paddingX margin, see below).
      return [`>  ${CURSOR_MARKER}`];
    }
    // Selected with text: the Input's own "> " prompt stays as the marker.
    // Prepend the same 1-col margin Text rows get (paddingX=1), so the typed
    // text lines up with the option text column instead of jutting one
    // column left.
    return this.inner.render(Math.max(1, width - 1)).map((line) => ` ${line}`);
  }
}

/**
 * Option list with an always-visible input line below it. Looks like the
 * built-in `ui.select` dialog plus a standard input row: the input is
 * focused from the start, Enter submits it (ignored when empty), ↑ moves
 * back into the options. The typed value is kept while navigating.
 */
class MixedEntryList extends Container {
  private readonly theme: Theme;
  private readonly options: string[];
  private readonly inputIndex: number; // row below the options
  private readonly onSelect: (result: PickResult) => void;
  private readonly onCancel: () => void;
  private selectedIndex: number;
  private readonly listContainer = new Container();
  private readonly input: PaddedInput;
  private readonly titleText: Text;
  private readonly baseTitle: string;
  private countdownTimer?: ReturnType<typeof setInterval>;

  constructor(
    title: string,
    options: string[],
    theme: Theme,
    timeoutMs: number | undefined,
    tui: TUI,
    borderRule: ((s: string) => string) | undefined,
    onSelect: (result: PickResult) => void,
    onCancel: () => void,
  ) {
    super();
    this.theme = theme;
    this.options = options;
    this.inputIndex = options.length; // input row sits below the options
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.baseTitle = title;
    this.selectedIndex = 0; // highlight the first option, not the input line
    this.input = new PaddedInput(theme);
    this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);

    this.addChild(borderRule ? new DynamicBorder(borderRule) : new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        rawKeyHint("↑↓", "navigate") +
          "  " +
          keyHint("tui.select.confirm", "select") +
          "  " +
          keyHint("tui.select.cancel", "cancel"),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(borderRule ? new DynamicBorder(borderRule) : new DynamicBorder());
    this.updateList();
    this.startCountdown(timeoutMs, tui);
  }

  private startCountdown(timeoutMs: number | undefined, tui: TUI): void {
    if (!timeoutMs || timeoutMs <= 0) return;
    let remaining = Math.ceil(timeoutMs / 1000);
    this.countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        // Timeout itself is handled by the caller's abort signal closing the
        // dialog; the countdown only displays the remaining seconds.
        clearInterval(this.countdownTimer);
        this.countdownTimer = undefined;
        return;
      }
      this.titleText.setText(this.theme.fg("accent", this.theme.bold(`${this.baseTitle} (${remaining}s)`)));
      tui.requestRender();
    }, 1000);
  }

  private updateList(): void {
    this.listContainer.clear();
    for (let i = 0; i < this.options.length; i++) {
      const isSelected = i === this.selectedIndex;
      // Same two-space indent for both states. The ASCII `>` marker is one
      // column wide, so it never misaligns like a Unicode arrow can.
      const row = isSelected
        ? `> ${this.theme.fg("accent", this.theme.bold(this.options[i]))}`
        : `  ${this.theme.fg("text", this.options[i])}`;
      this.listContainer.addChild(new Text(row, 1, 0));
    }
    this.listContainer.addChild(this.input); // input line, always visible
    this.input.focused = this.selectedIndex === this.inputIndex;
  }

  private moveTo(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.inputIndex, index));
    this.updateList();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.selectedIndex === this.inputIndex) {
      // In the input line: ↑ goes back to the options; Enter submits the
      // typed value (ignored when empty); everything else edits the text,
      // so j/k and other keys type normally here.
      if (kb.matches(data, "tui.select.up")) {
        this.moveTo(this.inputIndex - 1);
        return;
      }
      if (kb.matches(data, "tui.select.confirm") || data === "\n") {
        const value = this.input.getValue();
        if (value.trim() !== "") this.onSelect({ type: "custom", value });
        return;
      }
      this.input.handleInput(data);
      this.input.invalidate();
      return;
    }
    if (kb.matches(data, "tui.select.up") || data === "k") this.moveTo(this.selectedIndex - 1);
    else if (kb.matches(data, "tui.select.down") || data === "j") this.moveTo(this.selectedIndex + 1);
    else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
      const option = this.options[this.selectedIndex];
      if (option) this.onSelect({ type: "option", value: option });
    }
  }

  dispose(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }
}

/**
 * Option list + always-visible input line, rendered in the editor area
 * exactly like the built-in `ui.select` dialog. Returns null on cancel /
 * abort, or the picked option / typed answer.
 */
async function pickWithCustomEntry(
  question: string,
  options: string[],
  timeoutMs: number | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<PickResult | null> {
  if (signal.aborted) return null;
  return ctx.ui.custom<PickResult | null>((tui, theme, _kb, done) => {
    let settled = false;
    const finish = (value: PickResult | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      done(value);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });

    const list = new MixedEntryList(
      question,
      options,
      theme,
      timeoutMs,
      tui,
      dialogBorderRule(theme, thinkingLevel),
      (result) => finish(result),
      () => finish(null),
    );
    return {
      render: (w) => list.render(w),
      invalidate: () => list.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
      dispose: () => {
        signal.removeEventListener("abort", onAbort);
        list.dispose();
      },
    };
  });
}

/**
 * Single mixed-mode dialog: fixed options and free input always coexist.
 *
 * The options are shown in the exact order the model passed them, with a
 * trailing "自定义回答" entry that opens the free-text box — free input
 * is always the final step. With no options it is a plain free-text input.
 *
 * Returning `undefined` always means the user cancelled / timed out.
 */
async function runMixedDialog(
  question: string,
  options: string[],
  placeholder: string | undefined,
  timeoutSeconds: number | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<DialogResult> {
  if (options.length === 0) {
    return { answer: await ctx.ui.input(question, placeholder ?? "", { signal }), source: "free-text" };
  }
  const picked = await pickWithCustomEntry(
    question,
    options,
    timeoutSeconds ? timeoutSeconds * 1_000 : undefined,
    thinkingLevel,
    signal,
    ctx,
  );
  if (picked === null) return { answer: undefined, source: "free-text" }; // cancelled / timed out
  if (picked.type === "custom") return { answer: picked.value, source: "free-text" };
  return { answer: picked.value, source: "option" };
}

export default function askUser(pi: ExtensionAPI) {
  const asks = new Map<string, AskRequest>();
  let nextAskId = 1;
  let activeThinkingLevel: ThinkingLevel | undefined;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    activeThinkingLevel = ctx.thinkingLevel;
  });
  pi.on("thinking_level_select", (event: { level: ThinkingLevel }) => {
    activeThinkingLevel = event.level;
  });

  function removeAsk(request: AskRequest): void {
    if (request.retentionTimer) clearTimeout(request.retentionTimer);
    if (request.pushTimer) clearTimeout(request.pushTimer);
    asks.delete(request.id);
  }

  function pruneAsks(): void {
    const completed = [...asks.values()].filter(askIsFinal).sort((a, b) => a.startedAt - b.startedAt);
    while (asks.size > MAX_RETAINED_ASKS && completed.length > 0) {
      removeAsk(completed.shift()!);
    }
  }

  function finalizeAsk(
    request: AskRequest,
    answer: string | undefined,
    error?: Error,
    source?: "option" | "free-text",
  ): void {
    if (request.finalized) return;
    request.finalized = true;
    if (error) {
      request.status = "failed";
      request.error = error.message;
    } else if (request.cancelRequested) {
      request.status = "cancelled";
    } else if (answer === undefined) {
      request.status = request.abort.signal.aborted ? "failed" : "cancelled";
      if (request.abort.signal.aborted) request.error = "timed out";
    } else {
      request.status = "answered";
      request.answer = answer;
      request.source = source ?? null;
      scheduleAnswerPush(request);
    }
    request.finish();
    request.retentionTimer = setTimeout(() => removeAsk(request), ASK_RETENTION_MS);
    request.retentionTimer.unref();
    pruneAsks();
  }

  // If the model does not collect the answer via user_input_wait within a
  // few seconds (e.g. it moved on after the 1-minute handoff), push the
  // a custom message — same pattern as requirements-goals' sendHint: it
  // reaches the model in LLM context, but display:false keeps it invisible
  // in the chat, and triggerTurn starts a new turn when the agent is idle.
  function scheduleAnswerPush(request: AskRequest): void {
    request.pushTimer = setTimeout(() => {
      if (request.status !== "answered" || request.delivered || request.answer === null) return;
      void pi.sendMessage(
        {
          customType: "ask-user",
          content: `【用户已回答】\n原问题:${request.question}\n回答:${request.answer}`,
          display: false,
          details: { requestId: request.id, kind: "answer-push" },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }, ANSWER_PUSH_DELAY_MS);
    request.pushTimer.unref();
  }

  function startAsk(
    question: string,
    options: string[],
    placeholder: string | undefined,
    timeoutSeconds: number | undefined,
    ctx: ExtensionContext,
  ): AskRequest {
    const id = `ask-${nextAskId++}`;
    const controller = new AbortController();
    const timeoutMs = timeoutSeconds ? timeoutSeconds * 1_000 : undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
      timeoutTimer.unref();
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const request: AskRequest = {
      id,
      question,
      options,
      status: "pending",
      answer: null,
      source: null,
      startedAt: Date.now(),
      completion,
      finish: resolveCompletion,
      abort: controller,
      cancelRequested: false,
      finalized: false,
      pendingReturns: 0,
      delivered: false,
    };
    asks.set(id, request);

    void (async () => {
      try {
        const result = await runMixedDialog(
          question,
          options,
          placeholder,
          timeoutSeconds,
          activeThinkingLevel,
          controller.signal,
          ctx,
        );
        finalizeAsk(request, result.answer, undefined, result.source);
      } catch (error) {
        finalizeAsk(request, undefined, error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    })();

    return request;
  }

  pi.registerTool({
    name: "user_input",
    label: "User Input (non-blocking)",
    description:
      "Ask the user a question — the ONLY supported way to get user input; never end your reply with a plain-text question. Mixed dialog: pass `options` in the order they should appear (a free-input entry is always appended last). If unanswered within 1 minute, returns a request ID — use user_input_wait to wait, inspect, or cancel. Only one question pending at a time.",
    promptSnippet: "Ask the user for input; hands off to user_input_wait",
    promptGuidelines: [
      "When you need the user to operate, answer, or confirm, MUST ask via user_input and wait via user_input_wait — never end your reply with a plain-text question",
      "Fixed-set answers (是/不是, yes/no, named choices) go in `options`, in the order they should appear; the dialog always ends with free input, so the user can still answer freely",
      "A returned request ID means the question is still open — user_input_wait action=wait (seconds ≈ how long the user may need), action=status, or action=cancel",
    ],
    parameters: askSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("UI not available (non-interactive mode); cannot ask the user.");
      }
      const pending = [...asks.values()].find((request) => !askIsFinal(request));
      if (pending) {
        throw new Error(
          `Another question (${pending.id}: "${pending.question}") is still pending. Wait for its answer with user_input_wait first.`,
        );
      }
      const request = startAsk(params.question, params.options ?? [], params.placeholder, params.timeout, ctx);
      await waitForAsk(request, HANDOFF_AFTER_SECONDS * 1_000, signal);

      if (signal?.aborted) {
        throw new Error(
          [
            "Tool call aborted by the user, but the question was NOT cancelled (detach-on-abort).",
            `Request ID: ${request.id} — still waiting for an answer. Use user_input_wait status/wait to follow it, or user_input_wait cancel to dismiss it.`,
          ].join("\n"),
        );
      }
      if (!askIsFinal(request)) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Question is still waiting for the user. Request ID: ${request.id}.`,
                "Use user_input_wait with action=wait (choose seconds based on how long the user may need), action=status to inspect, or action=cancel to dismiss the prompt.",
              ].join("\n"),
            },
          ],
          details: { requestId: request.id, status: request.status, question: params.question },
        };
      }
      const text = askStatusText(request);
      if (request.status === "failed") throw new Error(text);
      if (request.status === "answered") request.delivered = true;
      return {
        content: [{ type: "text", text }],
        details: {
          requestId: request.id,
          status: request.status,
          answer: request.answer,
          question: params.question,
          source: request.source,
          selectedFromOptions: (params.options ?? []).length > 0,
        },
      };
    },
  });

  pi.registerTool({
    name: "user_input_wait",
    label: "User Input Wait",
    description:
      "Control a handed-off user_input question: `wait` (seconds = expected response time), `status` (inspect), or `cancel` (dismiss).",
    promptSnippet: "Wait for, inspect, or cancel a pending user_input question",
    parameters: askWaitSchema,
    async execute(_toolCallId, params, signal) {
      const request = asks.get(params.requestId);
      if (!request) throw new Error(`Unknown or expired user input request: ${params.requestId}`);

      if (params.action === "cancel") {
        request.cancelRequested = true;
        request.abort.abort();
        await waitForAsk(request, STOP_WAIT_MS, signal);
      } else if (params.action === "wait") {
        if (params.seconds === undefined) throw new Error("seconds is required when action=wait");
        await waitForAsk(request, params.seconds * 1_000, signal);
      }
      if (signal?.aborted) {
        throw new Error(
          `user_input_wait ${params.action} was cancelled; request ${request.id} was not cancelled automatically.`,
        );
      }
      const text = askStatusText(request);
      if (!askIsFinal(request)) request.pendingReturns += 1;
      if (request.status === "answered") request.delivered = true;
      const guidance = !askIsFinal(request)
        ? request.pendingReturns >= 2
          ? AWAY_HINT
          : "The user has not replied yet."
        : `Question: ${request.question}`;
      if (request.status === "failed") throw new Error(text);
      return {
        content: [{ type: "text", text: [text, guidance].join("\n") }],
        details: {
          requestId: request.id,
          status: request.status,
          answer: request.answer,
          question: request.question,
        },
      };
    },
  });

  // --- plain-text question enforcement ---

  pi.on("session_shutdown", async () => {
    const activeAsks = [...asks.values()].filter((request) => !askIsFinal(request));
    for (const request of activeAsks) {
      request.cancelRequested = true;
      request.abort.abort();
    }
    await Promise.all(activeAsks.map((request) => waitForAsk(request, STOP_WAIT_MS)));
    for (const request of [...asks.values()]) {
      if (askIsFinal(request)) removeAsk(request);
    }
  });
}
