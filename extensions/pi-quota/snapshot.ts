/**
 * pi-quota machine-readable snapshot API.
 * Process-internal only — never inject into Agent history, system prompt, or task text.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { tightestQuota, type QuotaCard } from "./core.ts";
// NOTE: fetchAllQuotaCards is imported lazily inside fetchAllQuotaSnapshots/doFetchAll
// so that this module can be imported in test environments without a Pi runtime.
type FetchAllFn = (registry: ModelRegistry) => Promise<QuotaCard[]>;

export type QuotaStatus = "HEALTHY" | "INELIGIBLE" | "UNKNOWN";

export interface QuotaWindow {
  label: string;
  usedPct?: number;
  remainingPct?: number;
  resetAt?: number; // epoch ms
}

/**
 * Machine-readable quota snapshot for one provider pool.
 * Internal to the dispatch decision; MUST NOT appear in Agent history.
 */
export interface QuotaSnapshot {
  /** Provider identifier (safe to log): "openai-codex", "xai", etc. */
  provider: string;
  windows: QuotaWindow[];
  /** Lowest remaining% across all fresh windows. undefined = no data. */
  tightestRemainingPct: number | undefined;
  status: QuotaStatus;
  observedAt: number;
  error?: string;
}

export interface QuotaPolicy {
  /** % remaining threshold. Models≤ this are INELIGIBLE. Configured by user; must not be hardcoded at call sites. */
  thresholdPct: number;
}

/** Default policy constant. Tools should load actual value from user config; this is the v1 fallback. */
export const DEFAULT_QUOTA_POLICY: QuotaPolicy = { thresholdPct: 10 };

// ------- in-process coalescing & cache -------

/** One in-flight fetch at a time; concurrent calls share it. Cleared on completion. */
let allCardsFlight: Promise<QuotaCard[]> | null = null;

/** Last successful result. Invalidated by a new successful fetch. */
let cachedCards: { cards: QuotaCard[]; at: number } | null = null;

/** Max age for a "fresh" snapshot. After this, HEALTHY → UNKNOWN (conservative). */
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min

async function doFetchAll(registry: ModelRegistry): Promise<QuotaCard[]> {
  if (allCardsFlight) return allCardsFlight;
  // Lazy import avoids pulling Pi runtime into test environments
  const { fetchAllQuotaCards } = await import("./index.ts") as { fetchAllQuotaCards: FetchAllFn };
  const p = fetchAllQuotaCards(registry);
  allCardsFlight = p;
  p.then(
    (cards) => {
      cachedCards = { cards, at: Date.now() };
      allCardsFlight = null;
    },
    () => {
      allCardsFlight = null;
    },
  );
  return p;
}

/**
 * Fetch quota snapshots for ALL known providers.
 * Safe to call concurrently — concurrent calls share one in-flight request.
 * FAIL-OPEN: if fetch fails, all providers get status=UNKNOWN.
 * Results are NOT injected into Agent context.
 */
export async function fetchAllQuotaSnapshots(
  registry: ModelRegistry,
  policy: QuotaPolicy = DEFAULT_QUOTA_POLICY,
): Promise<Map<string, QuotaSnapshot>> {
  let cards: QuotaCard[];
  try {
    cards = await doFetchAll(registry);
  } catch {
    cards = [];
  }
  const map = new Map<string, QuotaSnapshot>();
  for (const card of cards) {
    map.set(card.providerId, cardToSnapshot(card, policy));
  }
  return map;
}

/**
 * Return cached snapshots (may be stale) without triggering a new fetch.
 * Useful when quota was recently fetched and an immediate result is acceptable.
 */
export function getCachedSnapshots(
  policy: QuotaPolicy = DEFAULT_QUOTA_POLICY,
): Map<string, QuotaSnapshot> {
  if (!cachedCards) return new Map();
  const age = Date.now() - cachedCards.at;
  const map = new Map<string, QuotaSnapshot>();
  for (const card of cachedCards.cards) {
    const snapshot = cardToSnapshot(card, policy);
    if (age > CACHE_TTL_MS) {
      map.set(card.providerId, applyStale(snapshot));
    } else {
      map.set(card.providerId, snapshot);
    }
  }
  return map;
}

/** Convert a QuotaCard to a snapshot. Pure function — safe to test. */
export function cardToSnapshot(card: QuotaCard, policy: QuotaPolicy): QuotaSnapshot {
  if (card.error) {
    return {
      provider: card.providerId,
      windows: [],
      tightestRemainingPct: undefined,
      status: "UNKNOWN",
      observedAt: Date.now(),
      error: card.error,
    };
  }

  const windows: QuotaWindow[] = card.rows.map((row) => ({
    label: row.label,
    usedPct: row.usedPct,
    remainingPct: Math.min(100, Math.max(0, 100 - row.usedPct)),
    resetAt: parseResetStr(row.reset),
  }));

  const tight = tightestQuota(card);
  const tightestRemainingPct = tight?.remainingPercent;
  const status = evaluateStatus(tightestRemainingPct, policy);

  return {
    provider: card.providerId,
    windows,
    tightestRemainingPct,
    status,
    observedAt: Date.now(),
  };
}

/** Derive quota status from tightest remaining % and policy. */
export function evaluateStatus(
  remainingPct: number | undefined,
  policy: QuotaPolicy,
): QuotaStatus {
  if (remainingPct === undefined) return "UNKNOWN";
  return remainingPct <= policy.thresholdPct ? "INELIGIBLE" : "HEALTHY";
}

/** Apply stale transformation: HEALTHY → UNKNOWN; INELIGIBLE stays INELIGIBLE. */
export function applyStale(snapshot: QuotaSnapshot): QuotaSnapshot {
  if (snapshot.status === "INELIGIBLE") return snapshot; // conservative
  return { ...snapshot, status: "UNKNOWN" };
}

/** Parse the human reset string back to epoch ms (best-effort, returns undefined on failure). */
function parseResetStr(reset: string | undefined): number | undefined {
  if (!reset) return undefined;
  const ms = Date.parse(reset);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
