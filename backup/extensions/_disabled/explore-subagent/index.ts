import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const CHILD_ENV = "PI_LOCAL_SUBAGENT_CHILD";

type ExploreMode = "shallow" | "deep";
type ExploreScope = "local" | "web" | "both";
type ThinkingTier = "low" | "medium" | "high";

type RunDetails = {
	status: "running" | "done";
	mode: ExploreMode;
	scope: ExploreScope;
	cwd: string;
	model: string;
	thinkingTier: ThinkingTier;
	thinking: ModelThinkingLevel;
	activity?: string;
	turns: number;
	usage: Usage;
};

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, next: Usage | undefined): void {
	if (!next) return;
	total.input += next.input || 0;
	total.output += next.output || 0;
	total.cacheRead += next.cacheRead || 0;
	total.cacheWrite += next.cacheWrite || 0;
	total.totalTokens += next.totalTokens || 0;
	total.cost.input += next.cost?.input || 0;
	total.cost.output += next.cost?.output || 0;
	total.cost.cacheRead += next.cost?.cacheRead || 0;
	total.cost.cacheWrite += next.cost?.cacheWrite || 0;
	total.cost.total += next.cost?.total || 0;
}

function resolveThinkingTier(model: Model<any>, tier: ThinkingTier): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	const canonicalLevels = supported.filter((level) => level !== "off" && level !== "minimal");
	const reasoningLevels = supported.filter((level) => level !== "off");
	const levels = canonicalLevels.length > 0 ? canonicalLevels : reasoningLevels.length > 0 ? reasoningLevels : supported;
	if (levels.length === 0) return "off";
	if (tier === "low") return levels[0]!;
	if (tier === "high") return levels.at(-1)!;
	return levels[Math.floor(levels.length / 2)]!;
}

function finalAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

function latestActivity(messages: Message[]): string | undefined {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		if (message?.role !== "assistant") continue;
		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
			const part = message.content[partIndex];
			if (part.type === "toolCall") {
				const args = part.arguments as Record<string, unknown>;
				if (part.name === "read") return `read ${String(args.path ?? args.file_path ?? "?")}`;
				if (part.name === "grep") return `grep ${String(args.pattern ?? "")}`;
				if (part.name === "find") return `find ${String(args.pattern ?? "*")}`;
				if (part.name === "ls") return `ls ${String(args.path ?? ".")}`;
				if (part.name === "bash") return `$ ${String(args.command ?? "")}`;
				return part.name;
			}
		}
	}
	return undefined;
}

function limitOutput(output: string): { text: string; savedPath?: string } {
	const lines = output.split("\n");
	let text = lines.slice(0, MAX_LINES).join("\n");
	let truncated = lines.length > MAX_LINES;
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
		truncated = true;
		while (Buffer.byteLength(text, "utf8") > MAX_BYTES) text = text.slice(0, -256);
	}
	if (!truncated) return { text };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-explore-"));
	const savedPath = path.join(dir, "result.md");
	fs.writeFileSync(savedPath, output, { encoding: "utf8", mode: 0o600 });
	return {
		text: `${text}\n\n[Output truncated to ${MAX_LINES} lines / 50KB. Full output: ${savedPath}]`,
		savedPath,
	};
}

function killProcessTree(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// Already exited.
		}
	}
}

async function runExplorer(
	mode: ExploreMode,
	scope: ExploreScope,
	thinkingTier: ThinkingTier,
	task: string,
	cwd: string,
	model: Model<any>,
	signal: AbortSignal | undefined,
	onUpdate: ((value: { content: { type: "text"; text: string }[]; details: RunDetails }) => void) | undefined,
): Promise<{ output: string; details: RunDetails }> {
	const messages: Message[] = [];
	const modelName = `${model.provider}/${model.id}`;
	const thinking = resolveThinkingTier(model, thinkingTier);
	const details: RunDetails = {
		status: "running",
		mode,
		scope,
		cwd,
		model: modelName,
		thinkingTier,
		thinking,
		turns: 0,
		usage: emptyUsage(),
	};
	const args = [
		"--mode", "json", "-p",
		"--no-session",
		"--no-skills",
		"--model", modelName,
		"--thinking", thinking,
		"--append-system-prompt", path.join(ROOT, `${mode}.md`),
		`Mode: ${mode}\nScope: ${scope}\nThinking tier: ${thinkingTier} (resolved to ${thinking} for ${modelName})\n\nStandalone task brief:\n${task}`,
	];

	const proc = spawn("pi", args, {
		cwd,
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, [CHILD_ENV]: "1" },
	});
	let stdout = "";
	let stderr = "";
	let aborted = false;

	const emitUpdate = () => {
		details.activity = latestActivity(messages);
		const preview = finalAssistantText(messages) || details.activity || "Starting isolated explorer…";
		onUpdate?.({ content: [{ type: "text", text: preview }], details });
	};

	const abort = () => {
		aborted = true;
		killProcessTree(proc, "SIGTERM");
		setTimeout(() => killProcessTree(proc, "SIGKILL"), 1000).unref();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	const exitCode = await new Promise<number>((resolve, reject) => {
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { type?: string; message?: Message };
					if (event.type === "message_end" && event.message) {
						messages.push(event.message);
						if (event.message.role === "assistant") {
							details.turns++;
							addUsage(details.usage, event.message.usage);
						}
						emitUpdate();
					}
				} catch {
					// Ignore non-JSON diagnostics on stdout.
				}
			}
		});
		proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		proc.once("error", reject);
		proc.once("close", (code) => resolve(code ?? 0));
	});
	signal?.removeEventListener("abort", abort);

	if (aborted) throw new Error("Subagent canceled");
	if (stdout.trim()) {
		try {
			const event = JSON.parse(stdout) as { type?: string; message?: Message };
			if (event.type === "message_end" && event.message) messages.push(event.message);
		} catch {
			// Ignore incomplete final diagnostics.
		}
	}
	const output = finalAssistantText(messages);
	const assistant = [...messages].reverse().find((message) => message.role === "assistant");
	if (exitCode !== 0 || assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
		throw new Error(
			`Subagent failed (${modelName}:${thinking}, exit ${exitCode}): ${assistant?.errorMessage || stderr.trim() || output || "no output"}`,
		);
	}
	if (!output) throw new Error(`Subagent returned no assistant output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	details.status = "done";
	details.activity = undefined;
	return { output, details };
}

function formatTokens(value: number): string {
	return value < 1000 ? String(value) : value < 1000000 ? `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k` : `${(value / 1000000).toFixed(1)}M`;
}

export default function subagentExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run an isolated worker with the current model for investigation, implementation, verification, or web research. The child loads normal extensions and caps its result at 2000 lines or 50KB.",
		promptSnippet: "Delegate bounded or broad work to an isolated child agent",
		promptGuidelines: [
			"Use subagent as an isolated worker when delegating investigation, implementation, testing, verification, or web research will keep the main context focused",
			"subagent may use ds_explore_subagent for cheap reconnaissance, but it must directly verify material DS findings before changing files or returning conclusions",
			"Use subagent mode `shallow` for bounded work with a small frontier, and `deep` for broad, multi-step, cross-file, or multi-source work",
			"Set subagent scope to `local` for repository work, `web` for online research, or `both` when execution depends on local and upstream evidence",
			"Choose subagent thinking tier `low` for direct tasks, `medium` for normal tracing and implementation, or `high` for ambiguous, wide, or conflict-heavy work",
			"subagent has no parent conversation context, so include the background, exact objective, boundaries, constraints, cwd, expected output, and verification requirements in `task`",
		],
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Standalone discovery brief with all required context and expected evidence" }),
			mode: StringEnum(["shallow", "deep"] as const, { description: "Search breadth" }),
			scope: StringEnum(["local", "web", "both"] as const, { description: "Evidence sources to inspect" }),
			thinking: StringEnum(["low", "medium", "high"] as const, { description: "Relative thinking tier mapped to this model's lowest, middle, or highest supported level" }),
			cwd: Type.Optional(Type.String({ description: "Local working directory; defaults to the current cwd and remains useful for web-only tasks" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) throw new Error("subagent task must not be empty");
			if (!ctx.model) throw new Error("subagent requires an active parent model");
			const rawCwd = params.cwd?.replace(/^@/, "") ?? ctx.cwd;
			const cwd = path.resolve(ctx.cwd, rawCwd);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(cwd);
			} catch {
				throw new Error(`subagent cwd does not exist: ${cwd}`);
			}
			if (!stat.isDirectory()) throw new Error(`subagent cwd is not a directory: ${cwd}`);
			const run = await runExplorer(params.mode, params.scope, params.thinking, task, cwd, ctx.model, signal, onUpdate as never);
			const limited = limitOutput(run.output);
			return {
				content: [{ type: "text", text: limited.text }],
				details: { ...run.details, savedPath: limited.savedPath },
				usage: run.details.usage,
			};
		},
		renderCall(args, theme) {
			const preview = typeof args.task === "string" && args.task.length > 100 ? `${args.task.slice(0, 100)}…` : args.task || "";
			const badges = `[${args.mode ?? "?"}/${args.scope ?? "?"}/${args.thinking ?? "?"}]`;
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", badges)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme) {
			const details = result.details as RunDetails | undefined;
			const first = result.content[0];
			const output = first?.type === "text" ? first.text : "(no output)";
			if (!details) return new Text(output, 0, 0);
			const status = isPartial || details.status === "running" ? theme.fg("warning", "… Running") : theme.fg("success", "✓ Done");
			const usage = `${details.turns} turn${details.turns === 1 ? "" : "s"} ↑${formatTokens(details.usage.input)} ↓${formatTokens(details.usage.output)}`;
			const body = isPartial ? details.activity || output : expanded ? output : output.split("\n").slice(0, 8).join("\n");
			const identity = `${details.model}:${details.thinking} (${details.thinkingTier} tier, ${details.mode}/${details.scope})`;
			return new Text(`${status} ${theme.fg("accent", identity)}\n${body}\n${theme.fg("dim", usage)}`, 0, 0);
		},
	});
}
