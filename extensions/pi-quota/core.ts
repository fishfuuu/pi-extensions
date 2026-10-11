/**
 * Pure helper functions for pi-quota
 * 
 * Extracted from ui.ts and discover.ts to enable testing without Pi runtime dependencies.
 */

export type QuotaAdapter =
  | "codex"
  | "xai"
  | "ollama-cloud"
  | "deepseek-official"
  | "zhipu-cn-coding"
  | "zhipu-intl-coding";

export type QuotaRow = {
  label: string;
  usedPct: number;
  /** Display-only reset label for the /quota panel. Lossy — do not parse it back. */
  reset?: string;
  /**
   * Authoritative reset time as epoch ms. Carried alongside the display string so
   * snapshot consumers (pi-worker-selector, dashboards) never have to re-parse it.
   */
  resetAt?: number;
};
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

/** Drop providers that are not actually connected (no API key / OAuth). */
export function configuredQuotaCards(cards: QuotaCard[]): QuotaCard[] {
  return cards.filter((c) => c.error !== "MISSING_CREDENTIAL");
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
 * Keys that dismiss the quota overlay.
 * Pi Web's extension-panel Close button injects Ctrl+C (\\x03), not Escape.
 */
export function isQuotaPanelCloseInput(data: string): boolean {
  return data === "\x1b" || data === "\x03" || data === "q" || data === "Q";
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

export function matchZhipuCnCodingProvider(origin: string | undefined): boolean {
  return origin === "https://open.bigmodel.cn";
}

export function matchZhipuIntlCodingProvider(origin: string | undefined): boolean {
  return origin === "https://api.z.ai";
}

export function matchAdapter(origin: string | undefined): QuotaAdapter | undefined {
  if (matchCodexProvider(origin)) return "codex";
  if (matchXaiProvider(origin)) return "xai";
  if (matchOllamaCloudProvider(origin)) return "ollama-cloud";
  if (matchDeepseekOfficialProvider(origin)) return "deepseek-official";
  if (matchZhipuCnCodingProvider(origin)) return "zhipu-cn-coding";
  if (matchZhipuIntlCodingProvider(origin)) return "zhipu-intl-coding";
  return undefined;
}

// ---------------------------------------------------------------------------
// Ollama Cloud — /api/balance (remaining quota) + /api/usage (request counts)
// ---------------------------------------------------------------------------

export function asRec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export type OllamaQuotaRow = {
  label: string;
  usedPct: number;
  /** ISO reset time exactly as the provider reports it; callers format it for the panel. */
  resetIso?: string;
};

export type OllamaBalanceView = {
  rows: OllamaQuotaRow[];
  extras: string[];
};

/**
 * Map https://ollama.com/api/balance.
 *
 * Legacy plans report included.session / included.weekly as remaining_percent
 * (0-100, remaining) plus resets_at. Plans on usage credits report
 * included.balance_usd / allowance_usd / period instead. Returns undefined when
 * neither shape is present, so callers surface SCHEMA_MISMATCH instead of an empty card.
 */
export function ollamaBalanceView(data: unknown): OllamaBalanceView | undefined {
  const root = asRec(data);
  const included = asRec(root?.included);
  if (!included) return undefined;
  const rows: OllamaQuotaRow[] = [];
  const extras: string[] = [];
  const addWindow = (label: string, value: unknown): void => {
    const rec = asRec(value);
    const remaining = asNum(rec?.remaining_percent);
    if (remaining === undefined || remaining < 0 || remaining > 100) return;
    rows.push({ label, usedPct: 100 - remaining, resetIso: asStr(rec?.resets_at) });
  };
  addWindow("5h", included.session);
  addWindow("Weekly", included.weekly);
  const balanceUsd = asNum(included.balance_usd);
  const allowanceUsd = asNum(included.allowance_usd);
  if (balanceUsd !== undefined) {
    if (allowanceUsd !== undefined && allowanceUsd > 0) {
      const usedPct = ((allowanceUsd - balanceUsd) / allowanceUsd) * 100;
      rows.push({
        label: "Monthly",
        // Balance is a USD amount: round away binary float noise (the panel shows 0.1%).
        usedPct: Math.min(100, Math.max(0, Math.round(usedPct * 100) / 100)),
        resetIso: asStr(asRec(included.period)?.until),
      });
    } else {
      extras.push("Included $" + balanceUsd.toFixed(2));
    }
  }
  const purchased = asNum(asRec(root?.purchased)?.balance_usd);
  if (purchased) extras.push("Purchased $" + purchased.toFixed(2));
  if (rows.length === 0 && extras.length === 0) return undefined;
  return { rows, extras };
}

/** One line for a /api/usage window, e.g. "7d 1613 req · $0.42". */
export function ollamaUsageLine(data: unknown, range: string): string | undefined {
  const totals = asRec(asRec(data)?.totals);
  const count = asNum(totals?.request_count);
  if (count === undefined || count < 0) return undefined;
  const usd = asNum(totals?.usage_usd);
  const cost = usd === undefined ? "" : " · $" + (usd < 1 ? usd.toFixed(4) : usd.toFixed(2));
  return range + " " + Math.round(count) + " req" + cost;
}
