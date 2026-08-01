import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Provider id in `auth.json` — same format as deepseek, xiaomi, etc. */
export const JINA_PROVIDER = "jina-2webtools";

/** Resolve Jina API key from PI AuthStorage (per-user `auth.json`). */
export async function resolveJinaApiKey(
  registry?: ModelRegistry
): Promise<string | undefined> {
  if (!registry) return undefined;
  const key = await registry.getApiKeyForProvider(JINA_PROVIDER);
  return key?.trim() || undefined;
}
