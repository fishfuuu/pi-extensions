import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  originOf,
  matchCodexProvider,
  matchXaiProvider,
  matchOllamaCloudProvider,
  matchDeepseekOfficialProvider,
  matchAdapter,
  type QuotaAdapter,
} from "./core.ts";

export type { QuotaAdapter };
export { originOf, matchAdapter };

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
