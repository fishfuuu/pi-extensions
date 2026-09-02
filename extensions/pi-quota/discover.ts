import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type QuotaAdapter = "codex" | "xai" | "ollama-cloud" | "deepseek-official";

export type QuotaTarget = {
  providerId: string;
  displayName: string;
  adapter: QuotaAdapter;
};

export type ProviderMeta = {
  providerId: string;
  displayName: string;
  origin?: string;
};

export function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

export function matchCodexProvider(origin: string | undefined): boolean {
  return origin === "https://chatgpt.com";
}

export function matchXaiProvider(origin: string | undefined): boolean {
  return origin === "https://api.x.ai";
}

export function matchOllamaCloudProvider(origin: string | undefined): boolean {
  return origin === "https://ollama.com";
}

export function matchDeepseekOfficialProvider(origin: string | undefined): boolean {
  return origin === "https://api.deepseek.com";
}

export function matchAdapter(origin: string | undefined): QuotaAdapter | undefined {
  if (matchCodexProvider(origin)) return "codex";
  if (matchXaiProvider(origin)) return "xai";
  if (matchOllamaCloudProvider(origin)) return "ollama-cloud";
  if (matchDeepseekOfficialProvider(origin)) return "deepseek-official";
  return undefined;
}

export function discoverFromMeta(list: ProviderMeta[]): QuotaTarget[] {
  const out: QuotaTarget[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const adapter = matchAdapter(item.origin);
    if (!adapter) continue;
    if (seen.has(item.providerId)) continue;
    seen.add(item.providerId);
    out.push({
      providerId: item.providerId,
      displayName: item.displayName || item.providerId,
      adapter,
    });
  }
  return out;
}

export function discoverQuotaTargets(registry: ModelRegistry): QuotaTarget[] {
  const metas: ProviderMeta[] = [];
  const seen = new Set<string>();
  const add = (providerId: string) => {
    if (!providerId || seen.has(providerId)) return;
    seen.add(providerId);
    const native = registry.getProvider(providerId);
    const sample = registry.getAll().find((m) => m.provider === providerId);
    const origin = originOf(sample?.baseUrl) ?? originOf(native?.baseUrl);
    let displayName = providerId;
    try {
      const label = registry.getProviderDisplayName(providerId);
      if (label && label.trim()) displayName = label.trim();
    } catch {
      if (native?.name) displayName = native.name;
    }
    metas.push({ providerId, displayName, origin });
  };
  try {
    for (const id of registry.getRegisteredProviderIds()) add(id);
  } catch {
    /* ignore */
  }
  for (const model of registry.getAll()) add(model.provider);
  return discoverFromMeta(metas);
}
