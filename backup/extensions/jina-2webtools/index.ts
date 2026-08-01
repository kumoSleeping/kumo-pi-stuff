import {
  type ExtensionAPI,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveJinaApiKey } from "./_lib/jina-2webtools-auth.ts";

/** Only Grok models use provider-native search; GPT models use Jina's tools. */
function usesProviderNativeSearch(model?: { id?: string; provider?: string } | null): boolean {
  if (!model) return false;
  const provider = model.provider?.toLowerCase();
  return !!(model.id?.toLowerCase().includes("grok") || provider === "xai");
}

const JINA_TOOL_NAMES = ["parallel_search_web", "read_url"] as const;
const JINA_MCP_URL = "https://mcp.jina.ai/v1";
const JINA_AUTH_HINT =
  'Add jina-2webtools to auth.json: { "jina-2webtools": { "type": "api_key", "key": "jina_..." } }';

type ReaderMode = "fast" | "standard" | "detailed";

interface MCPToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

const MODE_HEADERS: Record<ReaderMode, Record<string, string>> = {
  fast: { "X-Engine": "curl", "X-Respond-Timing": "visible-content" },
  standard: { "X-Engine": "auto", "X-Respond-Timing": "resource-idle" },
  detailed: { "X-Engine": "browser", "X-Respond-Timing": "network-idle" },
};

function addJinaCost(tokens: number): void {
  const global = globalThis as Record<string, unknown>;
  global.__jinaCalls = ((global.__jinaCalls as number) || 0) + 1;
  global.__jinaTokens = ((global.__jinaTokens as number) || 0) + tokens;
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function responseError(prefix: string, response: Response, text: string): Error {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 400);
  return new Error(`${prefix}: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
}

function textFromMcpResult(result: MCPToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

function parseMcpResponse(text: string): MCPToolResult {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(value));
      } catch {
        // A non-JSON SSE event is irrelevant; retain a useful parse error below.
      }
    }
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const payload = candidate as { error?: { message?: unknown }; result?: unknown };
    if (payload.error) {
      throw new Error(`Jina MCP error: ${typeof payload.error.message === "string" ? payload.error.message : JSON.stringify(payload.error)}`);
    }
    if (payload.result && typeof payload.result === "object") {
      const result = payload.result as MCPToolResult;
      if (!Array.isArray(result.content)) throw new Error("Jina MCP returned a result without content");
      return result;
    }
  }

  throw new Error(`Jina MCP response could not be parsed: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
}

async function callJinaMCP(
  method: string,
  params: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MCPToolResult> {
  const response = await fetch(JINA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
    signal: mergeSignal(signal, 30_000),
  });
  const text = await response.text();
  if (!response.ok) throw responseError("Jina MCP request failed", response, text);
  const result = parseMcpResponse(text);
  if (result.isError) throw new Error(textFromMcpResult(result) || `Jina MCP ${method} failed`);
  return result;
}

async function countTokens(text: string, apiKey: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch("https://api.jina.ai/v1/segment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text, tokenizer: "cl100k_base" }),
      signal: mergeSignal(signal, 3_000),
    });
    if (!response.ok) return 0;
    const data = await response.json() as Record<string, unknown>;
    return typeof data.num_tokens === "number" && Number.isFinite(data.num_tokens)
      ? data.num_tokens
      : 0;
  } catch {
    return 0;
  }
}

async function readUrlDirect(
  url: string,
  apiKey: string,
  mode: ReaderMode,
  withAllLinks: boolean,
  withAllImages: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Md-Link-Style": "discarded",
    ...MODE_HEADERS[mode],
  };
  if (withAllLinks) headers["X-With-Links-Summary"] = "all";
  if (withAllImages) headers["X-With-Images-Summary"] = "true";
  else headers["X-Retain-Images"] = "none";

  const response = await fetch("https://r.jina.ai/", {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
    signal: mergeSignal(signal, mode === "detailed" ? 45_000 : 20_000),
  });
  const body = await response.text();
  if (!response.ok) throw responseError("Jina Reader request failed", response, body);

  let payload: { data?: { url?: unknown; title?: unknown; description?: unknown; content?: unknown } };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Jina Reader returned invalid JSON: ${body.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  const data = payload.data;
  if (!data || typeof data !== "object") throw new Error("Jina Reader returned no page data");

  const parts = [`url: ${typeof data.url === "string" ? data.url : url}`];
  if (typeof data.title === "string" && data.title) parts.push(`title: ${data.title}`);
  if (typeof data.description === "string" && data.description) parts.push(`description: ${data.description}`);
  if (typeof data.content === "string" && data.content) parts.push("", data.content);
  return parts.join("\n");
}

async function requireJinaApiKey(registry?: ModelRegistry): Promise<string> {
  const key = await resolveJinaApiKey(registry);
  if (!key) throw new Error(`Jina API key not configured. ${JINA_AUTH_HINT}`);
  return key;
}

function syncJinaToolsForModel(pi: ExtensionAPI, model?: { id?: string; provider?: string } | null): void {
  const active = pi.getActiveTools();
  if (usesProviderNativeSearch(model)) {
    const next = active.filter((name) => !(JINA_TOOL_NAMES as readonly string[]).includes(name));
    if (next.length !== active.length) pi.setActiveTools(next);
    return;
  }
  const missing = JINA_TOOL_NAMES.filter((name) => !active.includes(name));
  if (missing.length > 0) pi.setActiveTools([...new Set([...active, ...missing])]);
}

function firstQuery(args: { searches?: Array<{ query?: unknown }> }): string {
  const query = args.searches?.[0]?.query;
  return typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
}

function searchSummary(args: { searches?: Array<{ query?: unknown }> }): string {
  const count = args.searches?.length ?? 0;
  const noun = count === 1 ? "query" : "queries";
  const query = firstQuery(args);
  return query && count === 1 ? `Web Search 1 query (${query})` : `Web Search ${count} ${noun}`;
}

function readSummary(args: { url?: unknown }): string {
  const rawUrl = typeof args.url === "string" ? args.url : "";
  if (!rawUrl) return "Read URL";
  try {
    const parsed = new URL(rawUrl);
    const target = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    return `Read ${target.length > 72 ? `${target.slice(0, 71)}…` : target}`;
  } catch {
    return `Read ${rawUrl.length > 72 ? `${rawUrl.slice(0, 71)}…` : rawUrl}`;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    queueMicrotask(() => syncJinaToolsForModel(pi, ctx.model));
  });
  pi.on("model_select", (event) => {
    syncJinaToolsForModel(pi, event.model);
  });

  pi.registerTool({
    name: "parallel_search_web",
    label: "Search web",
    description: "Search the web with up to five independent queries and return ranked current results.",
    promptSnippet: "Search the web with parallel queries",
    promptGuidelines: [
      "Use parallel_search_web for current information; use two or three complementary, source-specific queries when corroboration matters",
      "Use read_url to inspect a promising result rather than relying only on a search snippet",
    ],
    parameters: Type.Object({
      searches: Type.Array(Type.Object({
        query: Type.String({ description: "Search query", minLength: 1, maxLength: 500 }),
        num: Type.Optional(Type.Integer({ description: "Results to return, default 30", minimum: 1, maximum: 100 })),
        tbs: Type.Optional(Type.String({ description: "Search-engine time filter" })),
        location: Type.Optional(Type.String({ description: "Search location" })),
        gl: Type.Optional(Type.String({ description: "Country code" })),
        hl: Type.Optional(Type.String({ description: "Language code" })),
      }), { description: "Independent searches", minItems: 1, maxItems: 5 }),
      timeout: Type.Optional(Type.Integer({ description: "Overall timeout in milliseconds, default 30000", minimum: 1_000, maximum: 60_000 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await requireJinaApiKey(ctx.modelRegistry);
      const result = await callJinaMCP("parallel_search_web", {
        searches: params.searches,
        timeout: params.timeout ?? 30_000,
      }, apiKey, signal);
      const text = textFromMcpResult(result);
      if (!text) throw new Error("Jina search returned no text results. Refine the query and retry.");
      // Jina's MCP search is charged as a fixed 10,000-token call.
      const jinaTokens = 10_000;
      addJinaCost(jinaTokens);
      return {
        content: [{ type: "text", text }],
        details: { operation: "search" as const, summary: searchSummary(params), jinaTokens },
      };
    },
  });

  pi.registerTool({
    name: "read_url",
    label: "Read URL",
    description: "Read one web page or PDF as clean Markdown. Use mode only when the default reader result is insufficient.",
    promptSnippet: "Read a web page or PDF as Markdown",
    promptGuidelines: [
      "Use read_url to inspect the contents of a specific URL, including a PDF",
      "Use the default read_url mode first; retry with detailed only when the page is essential and the default result is incomplete",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP(S) web page or PDF URL", minLength: 1, maxLength: 8_192 }),
      mode: Type.Optional(Type.Union([
        Type.Literal("fast"),
        Type.Literal("standard"),
        Type.Literal("detailed"),
      ], { description: "Reader mode: fast (curl), standard (resource idle), or detailed (browser network idle)" })),
      withAllLinks: Type.Optional(Type.Boolean({ description: "Include all links" })),
      withAllImages: Type.Optional(Type.Boolean({ description: "Include all images" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await requireJinaApiKey(ctx.modelRegistry);
      const mode = params.mode as ReaderMode | undefined;
      let text: string;
      if (mode) {
        text = await readUrlDirect(params.url, apiKey, mode, params.withAllLinks ?? false, params.withAllImages ?? false, signal);
      } else {
        const result = await callJinaMCP("read_url", {
          url: params.url,
          withAllLinks: params.withAllLinks ?? false,
          withAllImages: params.withAllImages ?? false,
        }, apiKey, signal);
        text = textFromMcpResult(result);
      }
      if (!text) throw new Error(`Jina Reader returned no content for ${params.url}. Check the URL or retry with a different mode.`);

      let jinaTokens = await countTokens(text, apiKey, signal);
      if (jinaTokens === 0) jinaTokens = Math.max(1, Math.round(text.length / 3));
      addJinaCost(jinaTokens);
      return {
        content: [{ type: "text", text }],
        details: { operation: "read" as const, summary: readSummary(params), jinaTokens, mode: mode ?? "default" },
      };
    },
  });
}
