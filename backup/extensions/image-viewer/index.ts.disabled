/**
 * Image Viewer Extension — describe_image tool + /vision-model command
 *
 * describe_image:
 *   When the main model doesn't support vision (e.g., DeepSeek), delegates
 *   image description to a separate vision-capable model.
 *   Auto-disabled when the main model supports vision natively.
 *
 * /vision-model:
 *   Interactive command to select which vision model describe_image uses.
 *   Choice persists to ~/.pi/agent/vision-model.json.
 *
 * The vision model is instructed minimally: "Report exactly what is visible.
 * Transcribe text verbatim. Do not interpret, infer, or guess."
 * Detailed requirements come from the main model's question parameter.
 *
 * Priority (findVisionModel): stored config > VISION_MODEL env > candidates
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { complete, getModel, getModels, getProviders, type Model, type Message, type Api } from "@earendil-works/pi-ai/compat";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Preferred vision model in "provider/model" format. Set via env var to override. */
const PREFERRED_VISION_MODEL = process.env.VISION_MODEL || "xiaomi/mimo-v2.5";

/** Fallback vision models to try (provider/model), in priority order. */
const VISION_MODEL_CANDIDATES = [
	// OpenAI
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	// Anthropic
	"anthropic/claude-sonnet-4-5",
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-opus-4-5",
	// Google
	"google/gemini-2.5-flash",
	"google/gemini-2.5-pro",
	// Xiaomi
	"xiaomi/mimo-v2-omni",
	"xiaomi/mimo-v2.5",
	// OpenRouter
	"openrouter/openai/gpt-4o",
	// xAI
	"xai/grok-4",
];

const SUPPORTED_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".tiff",
	".svg",
]);

const MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".svg": "image/svg+xml",
};

const TOOL_NAME = "describe_image";

/** Config file storing the user's preferred vision model. */
const VISION_CONFIG_PATH = resolve(homedir(), ".pi/agent/vision-model.json");

// ── Vision Model Preference Persistence ──────────────────────────

function loadVisionConfig(): string | null {
	try {
		if (!existsSync(VISION_CONFIG_PATH)) return null;
		const raw = readFileSync(VISION_CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return (typeof parsed?.model === "string" && parsed.model) ? parsed.model : null;
	} catch { return null; }
}

async function saveVisionConfig(model: string | null): Promise<void> {
	const dir = resolve(VISION_CONFIG_PATH, "..");
	await mkdir(dir, { recursive: true });
	await writeFile(VISION_CONFIG_PATH, JSON.stringify({ model }, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMimeType(ext: string): string {
	return MIME_MAP[ext.toLowerCase()] || "image/png";
}

/** Check whether the current model supports images natively. */
function modelSupportsVision(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	const input = (model as { input?: string[] }).input;
	return Array.isArray(input) && input.includes("image");
}

/**
 * Sync the describe_image tool's active state with the current model's
 * vision capabilities. Only calls setActiveTools when the state actually
 * changes, to avoid invalidating the prompt cache unnecessarily.
 *
 * Also publishes the vision model name to globalThis for the status bar.
 */
async function syncDescribeImageTool(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const visionCapable = modelSupportsVision(ctx);
	const activeTools = pi.getActiveTools();
	const isActive = activeTools.includes(TOOL_NAME);

	const g = globalThis as Record<string, unknown>;

	if (visionCapable && isActive) {
		// Model can see images directly — remove the redundant tool.
		pi.setActiveTools(activeTools.filter((t) => t !== TOOL_NAME));
		g.__visionModelName = undefined;
	} else if (!visionCapable && !isActive) {
		// Model needs help — add the tool.
		pi.setActiveTools([...activeTools, TOOL_NAME]);
		// Resolve vision model name for the bar display
		g.__visionModelName = await resolveVisionModelName(ctx.modelRegistry);
	} else if (!visionCapable && isActive) {
		// Already active — update name in case credentials changed
		g.__visionModelName = await resolveVisionModelName(ctx.modelRegistry);
	}
	// Otherwise state already matches, do nothing (preserve cache).
}

/** Resolve the vision model name (just the model id, not provider/id) for display. */
async function resolveVisionModelName(
	modelRegistry: ExtensionAPI["modelRegistry"] | undefined,
): Promise<string | undefined> {
	const vm = await findVisionModel(modelRegistry);
	if (!vm) return undefined;
	return vm.model.id;
}

/**
 * Find a vision-capable model from the built-in catalog.
 * Returns the first match that:
 *  - Accepts image input
 *  - Has an available API key
 */
async function findVisionModel(
	modelRegistry: ExtensionAPI["modelRegistry"] | undefined,
): Promise<{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | null> {
	// 1. Try stored user preference (set via /vision-model)
	const storedModel = loadVisionConfig();
	if (storedModel) {
		const [provider, modelId] = storedModel.split("/");
		if (provider && modelId) {
			const model = getModel(provider, modelId);
			if (model && model.input.includes("image")) {
				if (modelRegistry) {
					const auth = await modelRegistry.getApiKeyAndHeaders(model);
					if (auth.ok && auth.apiKey) {
						return { model, apiKey: auth.apiKey, headers: auth.headers };
					}
				}
			}
		}
	}

	// 2. Try env var preference
	if (PREFERRED_VISION_MODEL) {
		const [provider, modelId] = PREFERRED_VISION_MODEL.split("/");
		if (provider && modelId) {
			const model = getModel(provider, modelId);
			if (model && model.input.includes("image")) {
				if (modelRegistry) {
					const auth = await modelRegistry.getApiKeyAndHeaders(model);
					if (auth.ok && auth.apiKey) {
						return { model, apiKey: auth.apiKey, headers: auth.headers };
					}
				}
			}
		}
	}

	// 3. Fall back to candidate list
	for (const candidate of VISION_MODEL_CANDIDATES) {
		const [provider, modelId] = candidate.split("/");
		if (!provider || !modelId) continue;

		const model = getModel(provider, modelId);
		if (!model || !model.input.includes("image")) continue;

		if (modelRegistry) {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) {
				return { model, apiKey: auth.apiKey, headers: auth.headers };
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ── Tool Registration ──────────────────────────────────────────────
	// Always register the tool. It may be disabled via setActiveTools when
	// the model supports vision natively, but the definition stays so it
	// can be re-enabled if the user switches to a non-vision model later.

	pi.registerTool({
		name: TOOL_NAME,
		label: "Describe Image",
		description: [
			"Read an image file and get a factual, verbatim description of its visible contents using a vision-capable model.",
			"Use this tool when you need to understand what's in an image file (screenshot, photo, diagram, chart, etc).",
			`Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}.`,
			"Set the VISION_MODEL env var to override the auto-detected model (e.g., 'xiaomi/mimo-v2-omni').",
			"Use /vision-model to interactively select the vision model.",
		].join(" "),
		promptSnippet: "Describe the contents of an image file using a separate vision model (screenshot, photo, diagram, etc)",
		promptGuidelines: [
			"Use describe_image when you need to see what's in an image (screenshot, photo, diagram, chart). Provide the file path.",
			"To focus on a specific area (e.g., an error message, a table cell, a button, the top-right corner), use the question parameter: describe_image(path='err.png', question='What does the red error banner say verbatim?').",
			"The vision model is instructed to transcribe literally — it will report text verbatim and describe layout factually without interpretation.",
		],
		parameters: Type.Object({
			path: Type.String({
				description:
					"Path to the image file to view (e.g., 'screenshot.png', '/tmp/photo.jpg')",
			}),
			question: Type.Optional(
				Type.String({
					description:
						"Focus the description on a specific area or ask a targeted question (e.g., 'What does the red error banner say?', 'List all filenames in the sidebar', 'Transcribe the top-left panel'). The vision model will report verbatim without interpretation.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// 1. Resolve and validate the file path
			const filePath = resolve(ctx.cwd, params.path);
			const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

			if (!SUPPORTED_EXTENSIONS.has(ext)) {
				return {
					content: [
						{
							type: "text",
							text: `Unsupported image format: ${ext}. Supported: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// 2. Read the image file
			let imageBuffer: Buffer;
			try {
				imageBuffer = await readFile(filePath);
			} catch (error: any) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to read image file "${filePath}": ${error.message || error}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// Enforce a reasonable size limit (20 MB)
			const MAX_SIZE = 20 * 1024 * 1024;
			if (imageBuffer.length > MAX_SIZE) {
				return {
					content: [
						{
							type: "text",
							text: `Image too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// 3. Find a vision-capable model
			const visionModel = await findVisionModel(ctx.modelRegistry);

			if (!visionModel) {
				return {
					content: [
						{
							type: "text",
							text: [
								"No vision-capable model found with a valid API key.",
								"",
								"To use this tool, configure one of the following providers:",
								"  - OpenAI: export OPENAI_API_KEY=...    (gpt-4o, gpt-4o-mini)",
								"  - Anthropic: export ANTHROPIC_API_KEY=... (claude-sonnet-4-5, etc)",
								"  - Google: export GOOGLE_API_KEY=...    (gemini-2.5-flash, etc)",
								"  - Xiaomi: export XIAOMI_API_KEY=...    (mimo-v2-omni, mimo-v2.5)",
								"",
								"Or set VISION_MODEL to override: export VISION_MODEL='xiaomi/mimo-v2-omni'",
							].join("\n"),
						},
					],
					details: {},
					isError: true,
				};
			}

			// 4. Build the prompt
			const question = params.question || "Describe this image in detail. Include all visible text, UI elements, layout structure, colors, and any important details.";

			const base64Data = imageBuffer.toString("base64");
			const mimeType = getMimeType(ext);

			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "image",
						data: base64Data,
						mimeType,
					},
					{
						type: "text",
						text: question,
					},
				],
				timestamp: Date.now(),
			};

			// 5. Call the vision model
			try {
				const response = await complete(
					visionModel.model,
					{
						systemPrompt: "Report exactly what is visible. Transcribe text verbatim. Do not interpret, infer, or guess.",
						messages: [userMessage],
					},
					{
						apiKey: visionModel.apiKey,
						headers: visionModel.headers,
						signal,
					},
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: "Image description was cancelled." }],
						details: {},
						isError: true,
					};
				}

				if (response.stopReason === "error") {
					return {
						content: [
							{
								type: "text",
								text: `Vision model error: ${response.errorMessage || "Unknown error"}`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const description = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				const modelName = `${visionModel.model.provider}/${visionModel.model.id}`;
				const usage = response.usage;
				const cost = usage?.cost?.total;

				return {
					content: [
						{
							type: "text",
							text: [
								`## Image Description (via ${modelName})`,
								"",
								description || "(no description returned)",
								"",
								cost !== undefined
									? `---\n*Cost: $${cost.toFixed(6)}*`
									: "",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: {
						model: modelName,
						path: filePath,
						format: mimeType,
						size: imageBuffer.length,
						usage: usage
							? {
									input: usage.input,
									output: usage.output,
									cost: usage.cost.total,
								}
							: undefined,
					},
				};
			} catch (error: any) {
				return {
					content: [
						{
							type: "text",
							text: `Vision model call failed: ${error.message || error}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// ── /vision-model command ───────────────────────────────────────

	pi.registerCommand("vision-model", {
		description: "Select the vision model used by describe_image",
		handler: async (_args, ctx) => {
			// Collect all vision-capable models that have an available API key
			const choices: { label: string; provider: string; id: string }[] = [];

			for (const provider of getProviders()) {
				let models;
				try { models = getModels(provider); } catch { continue; }
				for (const m of models) {
					if (!m.input.includes("image")) continue;
					const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(m as any);
					if (!auth?.ok || !auth.apiKey) continue;
					const label = `${provider}/${m.id}  (${m.name || m.id})`;
					choices.push({ label, provider, id: m.id });
				}
			}

			const current = loadVisionConfig();
			const items = [
				{ value: "__auto__", label: `Auto (${current || "first available"})` },
				...choices.map(c => ({ value: `${c.provider}/${c.id}`, label: c.label })),
			];

			if (items.length === 1) {
				ctx.ui.notify("No vision-capable models found with API keys.", "warning");
				return;
			}

			const selection = await ctx.ui.select("Vision model:", items.map(i => i.label));
			if (selection == null) return;

			const idx = items.findIndex(i => i.label === selection);
			if (idx < 0) return;

			const chosen = items[idx]!.value;
			const modelToSave = chosen === "__auto__" ? null : chosen;

			await saveVisionConfig(modelToSave);
			await syncDescribeImageTool(pi, ctx);

			const display = modelToSave || "auto";
			ctx.ui.notify(`Vision model: ${display}`, "info");
		},
	});

	// ── Auto-enable/disable based on model capabilities ──────────────
	//
	// When the main model supports vision natively (input includes "image"),
	// describe_image is removed from active tools to save context space.
	// When the model is text-only, the tool is enabled so the model can
	// delegate image description to a separate vision model.
	//
	// We only toggle when the state actually changes, to avoid invalidating
	// the prompt cache unnecessarily.

	pi.on("session_start", async (_event, ctx) => {
		await syncDescribeImageTool(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await syncDescribeImageTool(pi, ctx);
	});
}
