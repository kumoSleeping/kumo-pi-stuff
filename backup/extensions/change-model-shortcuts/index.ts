/**
 * Shift+←/→ switches models within the current provider, while Shift+↑/↓
 * cycles through all configured providers. The thinking level is preserved.
 *
 * By default, all available models from all providers appear in the rotation.
 * Create ~/.pi/agent/change-model-shortcuts.json to restrict which
 * providers and models show up:
 *
 * {
 *   "providers": {
 *     "openai-codex": {
 *       "models": ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]
 *     },
 *     "kimi-coding": {
 *       "models": ["k3", "kimi-for-coding"]
 *     }
 *   }
 * }
 *
 * - If a provider is listed, only its listed models are shown.
 * - If a provider is NOT listed, all of its models are shown.
 * - If the file is absent, every available model from every provider is shown.
 *
 * Run /reload-model-shortcuts to pick up config changes without restarting pi.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ProviderFilter {
	/** If set, only these model IDs appear in the rotation. Omit to show all. */
	models?: string[];
	/** Short aliases that map to model IDs, e.g. { "terra": "gpt-5.6-terra" } */
	aliases?: Record<string, string>;
}

interface ShortcutsConfig {
	providers: Record<string, ProviderFilter>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "change-model-shortcuts.json");

function loadConfig(): ShortcutsConfig | null {
	try {
		if (!existsSync(CONFIG_PATH)) return null;
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as ShortcutsConfig;
		if (parsed && typeof parsed === "object" && parsed.providers) return parsed;
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Runtime provider/model list — rebuilt from the registry + config
// ---------------------------------------------------------------------------

interface ProviderEntry {
	id: string;
	label: string;
	models: string[];
}

type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

function parseThinkingLevel(args: string): ThinkingLevel | undefined | null {
	const requested = args.trim().toLowerCase();
	if (requested === "") return undefined;
	return THINKING_LEVELS.has(requested as ThinkingLevel)
		? (requested as ThinkingLevel)
		: null;
}

function buildProviders(ctx: ExtensionContext): ProviderEntry[] {
	const config = loadConfig();
	const available = ctx.modelRegistry.getAvailable();

	// Group model ids by provider
	const providerModels = new Map<string, string[]>();
	for (const model of available) {
		const list = providerModels.get(model.provider);
		if (list) {
			list.push(model.id);
		} else {
			providerModels.set(model.provider, [model.id]);
		}
	}

	const result: ProviderEntry[] = [];
	for (const [providerId, modelIds] of providerModels) {
		const filter = config?.providers?.[providerId];
		const models = filter?.models
			? filter.models.filter((id) => modelIds.includes(id))
			: modelIds;

		if (models.length === 0) continue;

		result.push({
			id: providerId,
			label: ctx.modelRegistry.getProviderDisplayName(providerId),
			models,
		});
	}

	return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let providers: ProviderEntry[] = [];

	function rebuild(ctx: ExtensionContext): void {
		providers = buildProviders(ctx);
	}

	function getProvider(id: string): ProviderEntry | undefined {
		return providers.find((p) => p.id === id);
	}

	async function switchToModel(
		providerId: string,
		modelId: string,
		ctx: ExtensionContext,
		requestedThinkingLevel?: ThinkingLevel,
	): Promise<void> {
		const model = ctx.modelRegistry.find(providerId, modelId);
		if (!model) {
			ctx.ui.notify(`Model unavailable: ${providerId}/${modelId}`, "error");
			return;
		}

		const previousThinkingLevel = pi.getThinkingLevel();
		const alreadySelected =
			ctx.model?.provider === providerId && ctx.model?.id === modelId;
		if (!alreadySelected) {
			try {
				if (!(await pi.setModel(model))) {
					ctx.ui.notify(
						`Could not switch to ${model.name ?? model.id}: credentials unavailable`,
						"error",
					);
					return;
				}
			} catch (error) {
				ctx.ui.notify(
					`Could not switch to ${model.name ?? model.id}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
		}

		pi.setThinkingLevel(requestedThinkingLevel ?? previousThinkingLevel);
		ctx.ui.notify(
			`${alreadySelected ? "Using" : "Switched to"} ${model.name ?? model.id} (${pi.getThinkingLevel()})`,
			"info",
		);
	}

	async function cycleModel(
		direction: -1 | 1,
		ctx: ExtensionContext,
	): Promise<void> {
		const provider = getProvider(ctx.model?.provider ?? "");
		if (!provider) {
			ctx.ui.notify("No configured provider selected.", "warning");
			return;
		}
		const currentIndex = provider.models.indexOf(ctx.model?.id ?? "");
		const nextIndex =
			currentIndex === -1
				? direction === 1
					? 0
					: provider.models.length - 1
				: (currentIndex + direction + provider.models.length) %
					provider.models.length;
		await switchToModel(provider.id, provider.models[nextIndex]!, ctx);
	}

	async function switchProvider(
		providerId: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const provider = getProvider(providerId);
		if (!provider) return;

		const currentModel =
			ctx.model?.provider === providerId ? ctx.model.id : undefined;
		const modelId =
			currentModel && provider.models.includes(currentModel)
				? currentModel
				: provider.models[0]!;
		await switchToModel(providerId, modelId, ctx);
	}

	async function cycleProvider(
		direction: -1 | 1,
		ctx: ExtensionContext,
	): Promise<void> {
		if (providers.length === 0) {
			ctx.ui.notify("No providers available.", "warning");
			return;
		}
		const currentIndex = providers.findIndex(
			(p) => p.id === ctx.model?.provider,
		);
		const nextIndex =
			currentIndex === -1
				? direction === 1
					? 0
					: providers.length - 1
				: (currentIndex + direction + providers.length) % providers.length;
		await switchProvider(providers[nextIndex]!.id, ctx);
	}

	// Rebuild + register commands on every session start
	pi.on("session_start", async (_event, ctx) => {
		rebuild(ctx);
		registerCommands(ctx);
	});

	// Keybindings
	pi.registerShortcut("shift+left", {
		description: "Switch to the previous model from the current provider",
		handler: async (ctx) => cycleModel(-1, ctx),
	});
	pi.registerShortcut("shift+right", {
		description: "Switch to the next model from the current provider",
		handler: async (ctx) => cycleModel(1, ctx),
	});
	pi.registerShortcut("shift+up", {
		description: "Switch to the previous provider",
		handler: async (ctx) => cycleProvider(-1, ctx),
	});
	pi.registerShortcut("shift+down", {
		description: "Switch to the next provider",
		handler: async (ctx) => cycleProvider(1, ctx),
	});

	// /reload-model-shortcuts — pick up config changes at runtime
	pi.registerCommand("reload-model-shortcuts", {
		description: "Reload change-model-shortcuts config",
		handler: async (_args, ctx) => {
			rebuild(ctx);
			const names = providers.map((p) => p.label).join(", ");
			ctx.ui.notify(
				`Model shortcuts reloaded. ${providers.length} provider(s): ${names || "(none)"}`,
				"info",
			);
		},
	});

	// Dynamic slash commands — aliases from config, plus model-id fallbacks.
	// Re-registered every session_start; pi.registerCommand overwrites safely.
	function registerCommands(_ctx: ExtensionContext): void {
		const config = loadConfig();
		if (!config) return;

		for (const [providerId, filter] of Object.entries(config.providers)) {
			// Register aliases (e.g. /terra → gpt-5.6-terra)
			if (filter.aliases) {
				for (const [alias, modelId] of Object.entries(filter.aliases)) {
					pi.registerCommand(alias, {
						description: `Switch to ${providerId}/${modelId} (preserve thinking level)`,
						handler: async (args, cmdCtx) => {
							const level = parseThinkingLevel(args);
							if (level === null) {
								cmdCtx.ui.notify(
									`Usage: /${alias} [off|minimal|low|medium|high|xhigh|max]`,
									"error",
								);
								return;
							}
							await switchToModel(providerId, modelId, cmdCtx, level);
						},
					});
				}
			}

			// Also register each model id as a command (e.g. /gpt-5.6-terra)
			for (const modelId of filter.models ?? []) {
				pi.registerCommand(modelId, {
					description: `Switch to ${providerId}/${modelId} (preserve thinking level)`,
					handler: async (args, cmdCtx) => {
						const level = parseThinkingLevel(args);
						if (level === null) {
							cmdCtx.ui.notify(
								`Usage: /${modelId} [off|minimal|low|medium|high|xhigh|max]`,
								"error",
							);
							return;
						}
						await switchToModel(providerId, modelId, cmdCtx, level);
					},
				});
			}
		}
	}

}
