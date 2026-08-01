import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const STATUS_KEY = "custom-usage-footer";
const REFRESH_INTERVAL_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────────────

type UsageWindow = {
	usedPercent?: number;
	windowMinutes?: number;
	label?: string;
};

type DeepSeekBalance = {
	total: number;
	currency: string;
	granted?: number;
	toppedUp?: number;
};

type UsageSnapshot = {
	weekly?: UsageWindow;
	rolling?: UsageWindow;
	balance?: DeepSeekBalance;
};

type ApiProviderConfig = {
	kind: "api";
	id: string;
	usageUrl: string;
	cachePath: string;
	buildHeaders: (
		model: NonNullable<ExtensionContext["model"]>,
		auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
	) => Headers;
	parseResponse: (payload: unknown) => UsageSnapshot | undefined;
	renderStatus: (
		ctx: ExtensionContext,
		snapshot: UsageSnapshot | undefined,
		refreshFailed: boolean,
		lastUpdatedAt: number | undefined,
	) => string;
	commandName: string;
	commandDescription: string;
};

type ProviderConfig = ApiProviderConfig;

// ── Helpers ───────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function number(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") return number(Number(value));
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatMinutes(minutes: number): string {
	if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

// ── Cache (API providers only) ────────────────────────────────────────

type CachedEntry = {
	version: number;
	snapshot: UsageSnapshot;
};

function readCachedSnapshot(cachePath: string): UsageSnapshot | undefined {
	try {
		const cache = record(JSON.parse(readFileSync(cachePath, "utf8")));
		if ((cache as CachedEntry)?.version !== 1) return undefined;
		const snapshot = record((cache as CachedEntry).snapshot);
		if (!snapshot) return undefined;
		const parseWindow = (value: unknown): UsageWindow | undefined => {
			const window = record(value);
			if (!window) return undefined;
			return {
				usedPercent: number(window.usedPercent),
				windowMinutes: number(window.windowMinutes),
				label: typeof window.label === "string" ? window.label : undefined,
			};
		};
		const weekly = parseWindow(snapshot.weekly);
		const rolling = parseWindow(snapshot.rolling);
		return weekly || rolling ? { weekly, rolling } : undefined;
	} catch {
		return undefined;
	}
}

function cachedAt(cachePath: string): number | undefined {
	try {
		return statSync(cachePath).mtimeMs;
	} catch {
		return undefined;
	}
}

function saveCachedSnapshot(cachePath: string, snapshot: UsageSnapshot): void {
	try {
		const temporaryPath = `${cachePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify({ version: 1, snapshot }), "utf8");
		renameSync(temporaryPath, cachePath);
	} catch {
		// Cache persistence is optional; live usage remains available.
	}
}

// ── Codex provider (API) ──────────────────────────────────────────────

const AUTH_CLAIM = "https://api.openai.com/auth";

function extractAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
		const auth = record(record(payload)?.[AUTH_CLAIM]);
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function parseCodexResponse(payload: unknown): UsageSnapshot | undefined {
	const root = record(payload);
	const rateLimit = record(root?.rate_limit);
	const primary = record(rateLimit?.primary_window ?? rateLimit?.primary);
	if (!primary) return undefined;

	const usedPercent = number(primary.used_percent);
	const seconds = number(primary.limit_window_seconds);
	const windowMinutes =
		number(primary.window_minutes) ?? (seconds === undefined ? undefined : Math.ceil(seconds / 60));

	if (usedPercent === undefined && windowMinutes === undefined) return undefined;

	const weekly: UsageWindow = { usedPercent, windowMinutes, label: windowMinutes ? formatMinutes(windowMinutes) : undefined };
	return { weekly };
}

function renderCodexBar(ctx: ExtensionContext, window: UsageWindow | undefined): string {
	const BAR_WIDTH = 16;
	const usedPercent = window?.usedPercent;
	const usedBlocks = usedPercent === undefined
		? 0
		: Math.max(0, Math.min(BAR_WIDTH, usedPercent === 0 ? 0 : Math.ceil((usedPercent / 100) * BAR_WIDTH)));
	const remainingBlocks = BAR_WIDTH - usedBlocks;
	const remaining = ctx.ui.theme.fg("accent", "─".repeat(remainingBlocks));
	const used = ctx.ui.theme.fg("dim", "─".repeat(usedBlocks));
	const percent = usedPercent === undefined ? "?" : String(Math.max(0, Math.min(100, 100 - Math.round(usedPercent))));
	const label = window?.label ?? "Codex";
	return ctx.ui.theme.fg("dim", `${label} `) + remaining + used + ctx.ui.theme.fg("dim", ` ${percent}%`);
}

function renderCodexStatus(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, refreshFailed: boolean, lastUpdatedAt: number | undefined): string {
	const age = refreshFailed && lastUpdatedAt !== undefined
		? ctx.ui.theme.fg("dim", ` (${Math.max(1, Math.floor((Date.now() - lastUpdatedAt) / 60_000))} min ago)`)
		: "";
	return renderCodexBar(ctx, snapshot?.weekly) + age;
}

// ── Kimi provider (API) ───────────────────────────────────────────────

const KIMI_USER_AGENT = "KimiCLI/1.6";

function quotaWindow(value: unknown, label: string, windowMinutes?: number): UsageWindow | undefined {
	const root = record(value);
	if (!root) return undefined;
	const limit = number(root.limit ?? root.limit_amount);
	const used = number(root.used ?? root.used_amount);
	const remaining = number(root.remaining);
	const resolvedUsed = used ?? (remaining !== undefined && limit !== undefined ? limit - remaining : undefined);
	const usedPercent =
		resolvedUsed !== undefined && limit && limit > 0 ? (resolvedUsed / limit) * 100 : undefined;
	if (usedPercent === undefined) return undefined;
	return { usedPercent, windowMinutes, label };
}

function rollingWindowMinutes(window: unknown): number | undefined {
	const root = record(window);
	if (!root) return undefined;
	const duration = number(root.duration);
	const unit = String(root.timeUnit ?? root.time_unit ?? "").toUpperCase();
	if (duration === undefined) return undefined;
	if (unit.includes("MINUTE")) return duration;
	if (unit.includes("HOUR")) return duration * 60;
	if (unit.includes("DAY")) return duration * 60 * 24;
	return undefined;
}

function parseKimiResponse(payload: unknown): UsageSnapshot | undefined {
	const root = record(payload);
	if (!root) return undefined;

	const weekly = quotaWindow(root.usage, "1w", 7 * 24 * 60);

	let rolling: UsageWindow | undefined;
	const limits = Array.isArray(root.limits) ? root.limits : [];
	let best: { minutes: number; window: UsageWindow } | undefined;
	for (const item of limits) {
		const entry = record(item);
		if (!entry) continue;
		const minutes = rollingWindowMinutes(entry.window);
		const window = quotaWindow(entry.detail ?? entry, minutes ? formatMinutes(minutes) : "limit", minutes);
		if (!window || minutes === undefined) continue;
		if (!best || minutes < best.minutes) best = { minutes, window };
	}
	rolling = best?.window;

	if (!weekly && !rolling) return undefined;
	return { weekly, rolling };
}

function renderKimiBar(ctx: ExtensionContext, window: UsageWindow | undefined, fallbackLabel: string): string {
	const BAR_WIDTH = 10;
	const usedPercent = window?.usedPercent;
	const usedBlocks = usedPercent === undefined
		? 0
		: Math.max(0, Math.min(BAR_WIDTH, usedPercent === 0 ? 0 : Math.ceil((usedPercent / 100) * BAR_WIDTH)));
	const remainingBlocks = BAR_WIDTH - usedBlocks;
	const remaining = ctx.ui.theme.fg("accent", "─".repeat(remainingBlocks));
	const used = ctx.ui.theme.fg("dim", "─".repeat(usedBlocks));
	const percent = usedPercent === undefined ? "?" : String(Math.max(0, Math.min(100, 100 - Math.round(usedPercent))));
	const label = window?.label ?? fallbackLabel;
	return ctx.ui.theme.fg("dim", `${label} `) + remaining + used + ctx.ui.theme.fg("dim", ` ${percent}%`);
}

function renderKimiStatus(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, refreshFailed: boolean, lastUpdatedAt: number | undefined): string {
	const prefix = ctx.ui.theme.fg("dim", "Kimi ");
	const rolling = renderKimiBar(ctx, snapshot?.rolling, "5h");
	const weekly = renderKimiBar(ctx, snapshot?.weekly, "1w");
	const age = refreshFailed && lastUpdatedAt !== undefined
		? ctx.ui.theme.fg("dim", ` (${Math.max(1, Math.floor((Date.now() - lastUpdatedAt) / 60_000))} min ago)`)
		: "";
	return prefix + rolling + ctx.ui.theme.fg("dim", " · ") + weekly + age;
}

// ── DeepSeek provider (API — live balance) ────────────────────────────

function parseDeepSeekResponse(payload: unknown): UsageSnapshot | undefined {
	const root = record(payload);
	const infos = root?.balance_infos;
	const info = record(Array.isArray(infos) ? infos[0] : undefined);
	if (!info) return undefined;
	const total = number(info.total_balance);
	if (total === undefined) return undefined;
	return {
		balance: {
			total,
			currency: typeof info.currency === "string" ? info.currency : "CNY",
			granted: number(info.granted_balance),
			toppedUp: number(info.topped_up_balance),
		},
	};
}

function formatBalance(balance: DeepSeekBalance): string {
	const amount = Number.isInteger(balance.total) ? String(balance.total) : balance.total.toFixed(2);
	return balance.currency === "CNY" ? `¥${amount}` : `${amount} ${balance.currency}`;
}

function renderDeepSeekBalance(
	ctx: ExtensionContext,
	snapshot: UsageSnapshot | undefined,
	refreshFailed: boolean,
	lastUpdatedAt: number | undefined,
): string {
	const prefix = ctx.ui.theme.fg("dim", "DeepSeek ");
	const balance = snapshot?.balance
		? ctx.ui.theme.fg("accent", formatBalance(snapshot.balance))
		: ctx.ui.theme.fg("dim", "?");
	const age = refreshFailed && lastUpdatedAt !== undefined
		? ctx.ui.theme.fg("dim", ` (${Math.max(1, Math.floor((Date.now() - lastUpdatedAt) / 60_000))} min ago)`)
		: "";
	return prefix + balance + age;
}

// ── Provider registry ─────────────────────────────────────────────────

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const PROVIDERS: Record<string, ProviderConfig> = {
	"openai-codex": {
		kind: "api",
		id: "openai-codex",
		usageUrl: "https://chatgpt.com/backend-api/wham/usage",
		cachePath: join(AGENT_DIR, "codex-usage-footer.json"),
		buildHeaders: (model, auth) => {
			const headers = new Headers(model.headers);
			for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);
			if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
			const token = auth.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			const accountId = token ? extractAccountId(token) : undefined;
			if (accountId) headers.set("chatgpt-account-id", accountId);
			headers.set("accept", "application/json");
			headers.set("OAI-Language", "en");
			headers.set("originator", "pi");
			return headers;
		},
		parseResponse: parseCodexResponse,
		renderStatus: renderCodexStatus,
		commandName: "codex-usage",
		commandDescription: "Refresh the official OpenAI Codex usage shown in the footer",
	},
	"kimi-coding": {
		kind: "api",
		id: "kimi-coding",
		usageUrl: "https://api.kimi.com/coding/v1/usages",
		cachePath: join(AGENT_DIR, "kimi-usage-footer.json"),
		buildHeaders: (model, auth) => {
			const headers = new Headers(model.headers);
			for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);
			if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
			headers.set("accept", "application/json");
			headers.set("user-agent", KIMI_USER_AGENT);
			return headers;
		},
		parseResponse: parseKimiResponse,
		renderStatus: renderKimiStatus,
		commandName: "kimi-usage",
		commandDescription: "Refresh the Kimi Coding Plan usage shown in the footer",
	},
	deepseek: {
		kind: "api",
		id: "deepseek",
		usageUrl: "https://api.deepseek.com/user/balance",
		cachePath: join(AGENT_DIR, "deepseek-usage-footer.json"),
		buildHeaders: (model, auth) => {
			const headers = new Headers(model.headers);
			for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);
			if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
			headers.set("accept", "application/json");
			return headers;
		},
		parseResponse: parseDeepSeekResponse,
		renderStatus: renderDeepSeekBalance,
		commandName: "deepseek-usage",
		commandDescription: "Refresh the DeepSeek account balance shown in the footer",
	},
};

// ── Extension ─────────────────────────────────────────────────────────

type PerApiState = {
	snapshot: UsageSnapshot | undefined;
	updatedAt: number | undefined;
	failed: boolean;
};

export default function customUsageFooter(pi: ExtensionAPI) {
	const apiStates = new Map<string, PerApiState>();
	let refreshController: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let activeContext: ExtensionContext | undefined;
	let generation = 0;
	let activeConfig: ProviderConfig | undefined;

	function getConfig(ctx: ExtensionContext): ProviderConfig | undefined {
		return ctx.model?.provider ? PROVIDERS[ctx.model.provider] : undefined;
	}

	function render(ctx: ExtensionContext): void {
		const config = getConfig(ctx);
		if (!config) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		let s = apiStates.get(config.id);
		if (!s) {
			const snapshot = readCachedSnapshot(config.cachePath);
			s = { snapshot, updatedAt: snapshot ? cachedAt(config.cachePath) : undefined, failed: false };
			apiStates.set(config.id, s);
		}
		const status = config.renderStatus(ctx, s.snapshot, s.failed, s.updatedAt);
		ctx.ui.setStatus(STATUS_KEY, status);
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const config = getConfig(ctx);
		if (!config || refreshController || activeContext !== ctx) return;

		const runGeneration = generation;
		const controller = new AbortController();
		refreshController = controller;
		const isCurrent = () =>
			activeContext === ctx && generation === runGeneration && !controller.signal.aborted;

		try {
			const model = ctx.model;
			if (!model) throw new Error("No active model");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!isCurrent()) return;
			if (!auth.ok) throw new Error(auth.error);

			const headers = config.buildHeaders(model, auth);
			const response = await fetch(config.usageUrl, { method: "GET", headers, signal: controller.signal });
			if (!isCurrent()) return;
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const snapshot = config.parseResponse(JSON.parse(await response.text()));
			if (!isCurrent()) return;
			if (!snapshot) throw new Error("No usage windows");

			let s = apiStates.get(config.id);
			if (!s) {
				s = { snapshot, updatedAt: Date.now(), failed: false };
				apiStates.set(config.id, s);
			} else {
				s.snapshot = snapshot;
				s.updatedAt = Date.now();
				s.failed = false;
			}
			saveCachedSnapshot(config.cachePath, snapshot);
		} catch {
			const s = apiStates.get(config.id);
			if (s && isCurrent()) s.failed = true;
		} finally {
			if (refreshController === controller) refreshController = undefined;
			if (isCurrent()) render(ctx);
		}
	}

	function stop(): void {
		generation += 1;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		refreshController?.abort();
		refreshController = undefined;
		activeContext?.ui.setStatus(STATUS_KEY, undefined);
		activeContext = undefined;
		activeConfig = undefined;
	}

	function start(ctx: ExtensionContext): void {
		stop();
		const config = getConfig(ctx);
		if (ctx.mode !== "tui" || !config) return;

		activeContext = ctx;
		activeConfig = config;
		render(ctx);
		if (config.kind === "api") {
			void refresh(ctx);
			refreshTimer = setInterval(() => {
				if (activeContext) void refresh(activeContext);
			}, REFRESH_INTERVAL_MS);
		}
	}

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => stop());
	pi.on("model_select", (_event, ctx) => start(ctx));

	// Register per-provider commands
	for (const config of Object.values(PROVIDERS)) {
		pi.registerCommand(config.commandName, {
			description: config.commandDescription,
			handler: async (_args, ctx) => {
				const currentConfig = getConfig(ctx);
				if (!currentConfig || currentConfig.id !== config.id) {
					ctx.ui.notify(
						`${config.commandName} requires a ${config.id} model.`,
						"warning",
					);
					return;
				}
				await refresh(ctx);
			},
		});
	}
}
