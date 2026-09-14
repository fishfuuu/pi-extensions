/**
 * Pure deterministic worker model selector.
 * No I/O, no Pi session, no side effects. Fully testable.
 */

import type { QuotaSnapshot } from "../pi-quota/snapshot.ts";

/** Capability tiers that a pool model can satisfy. */
export type CapabilityTier = "small" | "medium" | "big";

/** Coarse cost tier for preference ordering. */
export type CostTier = "cheap" | "normal" | "expensive";

/** A model entry in the worker pool. */
export interface PoolEntry {
  /** Model spec: "provider/modelId" or "provider/modelId:effort". */
  model: string;
  /** Capability tiers this model can handle. */
  capability: CapabilityTier[];
  costTier?: CostTier;
}

/** How the worker requirement is specified. */
export type WorkerMode =
  | { kind: "tier"; requirement: CapabilityTier }
  | { kind: "explicit"; exactModel: string }
  | { kind: "forced"; exactModel: string };

/** Inputs to the selector. All are caller-provided; no I/O. */
export interface SelectorInput {
  mode: WorkerMode;
  pool: PoolEntry[];
  /** Quota snapshots keyed by provider (from fetchAllQuotaSnapshots). */
  quotaSnapshots: Map<string, QuotaSnapshot>;
  /** Authenticated+available models: "provider/modelId" strings. */
  availableModels: string[];
}

export type SelectorResult =
  | { outcome: "SELECTED"; model: string; reason: string }
  | { outcome: "STOP"; reason: string; affectedProvider?: string };

const COST_ORDER: Record<CostTier, number> = { cheap: 0, normal: 1, expensive: 2 };

/**
 * Select a worker model. Deterministic — same inputs produce same output.
 *
 * Precedence:
 *   1. Governance/forced → check exact model only, STOP if any constraint fails
 *   2. Explicit → check exact model only, STOP if any constraint fails
 *   3. Tier → filter pool → quota eligibility → cost sort → pick cheapest capable eligible
 */
export function selectWorkerModel(input: SelectorInput): SelectorResult {
  const { mode, pool, quotaSnapshots, availableModels } = input;
  const availableSet = new Set(availableModels.map((m) => m.toLowerCase()));

  if (mode.kind === "forced" || mode.kind === "explicit") {
    if (!isConcreteModelSpec(mode.exactModel)) {
      return {
        outcome: "STOP",
        reason: `${mode.kind} model is not a concrete provider/id spec: ${mode.exactModel || "(empty)"}`,
      };
    }
    return checkExact(
      stripThinkingSuffix(mode.exactModel),
      pool,
      quotaSnapshots,
      availableSet,
      mode.kind,
    );
  }

  return selectForTier(mode.requirement, pool, quotaSnapshots, availableSet);
}

function checkExact(
  exactModel: string,
  pool: PoolEntry[],
  quotaSnapshots: Map<string, QuotaSnapshot>,
  availableSet: Set<string>,
  kind: "forced" | "explicit",
): SelectorResult {
  const label = kind === "forced" ? "forced" : "explicit";

  // Must be in pool
  const inPool = pool.find((e) => e.model.toLowerCase() === exactModel.toLowerCase());
  if (!inPool) {
    return { outcome: "STOP", reason: `${label} model not in worker pool: ${exactModel}` };
  }

  // Must be available/authenticated
  if (!availableSet.has(exactModel.toLowerCase())) {
    return { outcome: "STOP", reason: `${label} model not available/authenticated: ${exactModel}` };
  }

  // Quota check — INELIGIBLE → STOP; UNKNOWN → pass (fail-open)
  const provider = providerOf(exactModel);
  const snap = quotaSnapshots.get(provider);
  if (snap?.status === "INELIGIBLE") {
    const pct = snap.tightestRemainingPct !== undefined ? `${snap.tightestRemainingPct.toFixed(0)}%` : "?%";
    return {
      outcome: "STOP",
      reason: `${label} model ${exactModel}: provider ${provider} quota ineligible (${pct} remaining)`,
      affectedProvider: provider,
    };
  }

  const quotaNote = snap ? `${provider}=${snap.status.toLowerCase()}` : `${provider}=unknown`;
  return {
    outcome: "SELECTED",
    model: inPool.model,
    reason: `${label}: ${inPool.model} | ${quotaNote}`,
  };
}

function selectForTier(
  requirement: CapabilityTier,
  pool: PoolEntry[],
  quotaSnapshots: Map<string, QuotaSnapshot>,
  availableSet: Set<string>,
): SelectorResult {
  // 1. Filter to capable + available/authenticated
  const candidates = pool.filter(
    (e) =>
      e.capability.includes(requirement) &&
      availableSet.has(e.model.toLowerCase()),
  );

  if (candidates.length === 0) {
    return {
      outcome: "STOP",
      reason: `no authenticated pool model with capability=${requirement}`,
    };
  }

  // 2. Separate eligible (HEALTHY or UNKNOWN) from ineligible
  const eligible: PoolEntry[] = [];
  const ineligible: PoolEntry[] = [];
  for (const e of candidates) {
    const snap = quotaSnapshots.get(providerOf(e.model));
    if (snap?.status === "INELIGIBLE") {
      ineligible.push(e);
    } else {
      eligible.push(e); // HEALTHY, UNKNOWN → fail-open → eligible
    }
  }

  if (eligible.length === 0) {
    const providers = [...new Set(ineligible.map((e) => {
      const p = providerOf(e.model);
      const snap = quotaSnapshots.get(p);
      const pct = snap?.tightestRemainingPct !== undefined ? `${snap.tightestRemainingPct.toFixed(0)}%` : "?%";
      return `${p}(${pct})`;
    }))];
    return {
      outcome: "STOP",
      reason: `all ${requirement} candidates quota-ineligible: ${providers.join(", ")}`,
    };
  }

  // 3. Sort by costTier ascending, then model spec for deterministic tiebreak
  eligible.sort((a, b) => {
    const ca = COST_ORDER[a.costTier ?? "normal"];
    const cb = COST_ORDER[b.costTier ?? "normal"];
    if (ca !== cb) return ca - cb;
    return a.model.localeCompare(b.model);
  });

  const selected = eligible[0];
  const provider = providerOf(selected.model);
  const snap = quotaSnapshots.get(provider);
  const quotaNote = snap
    ? `${provider}=${snap.status.toLowerCase()}(${snap.tightestRemainingPct !== undefined ? snap.tightestRemainingPct.toFixed(0) + "%" : "?"})`
    : `${provider}=unknown`;

  const excludedNotes = ineligible.map((e) => {
    const p = providerOf(e.model);
    const s = quotaSnapshots.get(p);
    const pct = s?.tightestRemainingPct !== undefined ? `${s.tightestRemainingPct.toFixed(0)}%` : "?";
    return `${p}=ineligible(${pct})`;
  });

  const reason = [
    `selected ${selected.model}`,
    `requirement=${requirement}`,
    quotaNote,
    ...excludedNotes,
  ].join(" | ");

  return { outcome: "SELECTED", model: selected.model, reason };
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Strip a DW thinking suffix. Colon-containing model ids (e.g. `:0731`) are kept. */
export function stripThinkingSuffix(spec: string): string {
  const trimmed = spec.trim();
  const i = trimmed.lastIndexOf(":");
  if (i <= 0) return trimmed;
  const suffix = trimmed.slice(i + 1).toLowerCase();
  if (THINKING_SUFFIXES.has(suffix)) return trimmed.slice(0, i);
  return trimmed;
}

/** Provider/id required. Bare or slash-less names are not deterministic. */
export function isConcreteModelSpec(spec: string): boolean {
  const s = stripThinkingSuffix(spec);
  const i = s.indexOf("/");
  return i > 0 && s.slice(i + 1).length > 0;
}

/** Extract provider from model spec "provider/modelId" or "provider/modelId:effort". */
export function providerOf(spec: string): string {
  return stripThinkingSuffix(spec).split("/")[0];
}
