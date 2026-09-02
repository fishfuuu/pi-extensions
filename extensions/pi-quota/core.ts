/**
 * Pure helper functions for pi-quota
 * 
 * Extracted from ui.ts and discover.ts to enable testing without Pi runtime dependencies.
 */

export type QuotaAdapter = "codex" | "xai" | "ollama-cloud" | "deepseek-official";

export type QuotaRow = { label: string; usedPct: number; reset?: string };
export type MixRow = { name: string; requests: number };
export type QuotaBalance = { currency: string; amount: string; available: boolean };
export type QuotaCard = {
  providerId: string;
  title: string;
  error?: string;
  rows: QuotaRow[];
  plan?: string;
  extras?: string[];
  mix?: MixRow[];
  mixWeekly?: boolean;
  balances?: QuotaBalance[];
};

export type TightestQuota = {
  label: string;
  remainingPercent: number;
  reset?: string;
};

export type NavState = {
  selectedIndex: number;
  expanded: Set<string>;
};

/**
 * Calculate remaining percentage from used percentage.
 */
export function remainingOf(usedPct: number): number {
  return Math.min(100, Math.max(0, 100 - usedPct));
}

/**
 * Extract provider IDs that have expandable mix data.
 */
export function expandableIds(cards: QuotaCard[]): string[] {
  return cards.filter((c) => c.mix && c.mix.length > 0).map((c) => c.providerId);
}

/**
 * Find the quota row with the least remaining percentage.
 */
export function tightestQuota(card: QuotaCard): TightestQuota | undefined {
  if (card.error || card.rows.length === 0) return undefined;
  let best = card.rows[0];
  let bestLeft = remainingOf(best.usedPct);
  for (const row of card.rows) {
    const left = remainingOf(row.usedPct);
    if (left < bestLeft) {
      best = row;
      bestLeft = left;
    }
  }
  return {
    label: best.label,
    remainingPercent: bestLeft,
    reset: best.reset,
  };
}

/**
 * Apply navigation action to state.
 */
export function applyNav(
  state: NavState,
  action: "up" | "down" | "enter" | "m",
  ids: string[],
): NavState {
  const expanded = new Set(state.expanded);
  if (ids.length === 0) return { selectedIndex: 0, expanded };
  const n = ids.length;
  let selectedIndex = ((state.selectedIndex % n) + n) % n;
  if (action === "up") selectedIndex = (selectedIndex - 1 + n) % n;
  if (action === "down") selectedIndex = (selectedIndex + 1) % n;
  if (action === "enter") {
    const id = ids[selectedIndex];
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }
  if (action === "m") {
    const allOpen = ids.every((id) => expanded.has(id));
    if (allOpen) {
      for (const id of ids) expanded.delete(id);
    } else {
      for (const id of ids) expanded.add(id);
    }
  }
  return { selectedIndex, expanded };
}

/**
 * Generate compact widget line for a quota card.
 */
export function balanceOk(b: QuotaBalance): boolean {
  const n = Number(b.amount);
  return b.available && Number.isFinite(n) && n > 0;
}

function balanceWidget(card: QuotaCard): string {
  const list = card.balances ?? [];
  if (list.length === 0) return `${card.title} · --`;
  if (!list.some(balanceOk)) return `${card.title} · unavailable`;
  return `${card.title} · ${list.map((b) => `${b.currency} ${b.amount}`).join(" · ")}`;
}

export function compactWidgetLines(cards: QuotaCard[]): string[] {
  return cards.map((c) => {
    if (c.error) return `${c.title} · ${c.error}`;
    if (c.balances && c.balances.length > 0) return balanceWidget(c);
    const tight = tightestQuota(c);
    if (!tight) return `${c.title} · --`;
    const pct = `${tight.label} ${tight.remainingPercent.toFixed(0)}% left`;
    return tight.reset ? `${c.title} · ${pct} · ${tight.reset}` : `${c.title} · ${pct}`;
  });
}

/**
 * Normalize provider origin for matching.
 */
export function normalizeOrigin(origin: string | undefined): string {
  if (!origin) return "";
  return origin.toLowerCase().trim();
}

/**
 * Check if a provider ID matches the given origin pattern.
 */
export function matchesProvider(providerId: string, origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const id = providerId.toLowerCase();
  return id === normalized || id.startsWith(`${normalized}-`) || id.startsWith(`${normalized}/`);
}

/**
 * Extract origin from URL.
 */
export function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Match specific quota adapter providers by origin.
 */
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
