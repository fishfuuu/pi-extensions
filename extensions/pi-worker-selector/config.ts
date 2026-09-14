import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapabilityTier, CostTier, PoolEntry } from "./core.ts";
import { DEFAULT_QUOTA_POLICY, type QuotaPolicy } from "../pi-quota/snapshot.ts";

/** Extended model-tiers.json schema (backward-compatible with existing DW format). */
interface ModelTiersFile {
  tiers?: Record<string, string>;
  workerPool?: Array<{
    model: string;
    capability: CapabilityTier[];
    costTier?: CostTier;
  }>;
  quotaPolicy?: {
    thresholdPct?: number;
  };
}

export interface WorkerSelectorConfig {
  pool: PoolEntry[];
  quotaPolicy: QuotaPolicy;
  /** Raw DW `tiers` map. Used to distinguish configured custom tiers from typos. */
  tiers: Record<string, string>;
}

const TIERS_FILE_PATH = join(homedir(), ".pi", "workflows", "model-tiers.json");

/**
 * Load worker selector config from model-tiers.json (extended schema).
 * Falls back gracefully if file is absent or has no workerPool section.
 *
 * Extension is backward-compatible: existing DW usage of tiers is unaffected.
 */
export function loadWorkerSelectorConfig(filePath = TIERS_FILE_PATH): WorkerSelectorConfig {
  let raw: ModelTiersFile = {};
  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8")) as ModelTiersFile;
    } catch {
      raw = {};
    }
  }

  const quotaPolicy: QuotaPolicy = {
    thresholdPct: raw.quotaPolicy?.thresholdPct ?? DEFAULT_QUOTA_POLICY.thresholdPct,
  };

  let pool: PoolEntry[];
  if (raw.workerPool && raw.workerPool.length > 0) {
    pool = raw.workerPool.map((e) => ({
      model: e.model,
      capability: e.capability,
      costTier: e.costTier,
    }));
  } else {
    pool = derivePoolFromTiers(raw.tiers ?? {});
  }

  return { pool, quotaPolicy, tiers: raw.tiers ?? {} };
}

/**
 * Derive a minimal worker pool from existing model-tiers.json tiers.
 * Each tier maps to the tier's capability; duplicate models accumulate capabilities.
 */
function derivePoolFromTiers(tiers: Record<string, string>): PoolEntry[] {
  const KNOWN_TIERS: Record<string, CapabilityTier> = {
    small: "small",
    medium: "medium",
    big: "big",
  };

  const entries: PoolEntry[] = [];
  const modelIndex = new Map<string, PoolEntry>();

  for (const [tier, model] of Object.entries(tiers)) {
    const capability = KNOWN_TIERS[tier];
    if (!capability || !model) continue;

    const existing = modelIndex.get(model);
    if (existing) {
      if (!existing.capability.includes(capability)) {
        existing.capability.push(capability);
      }
    } else {
      const entry: PoolEntry = { model, capability: [capability], costTier: "normal" };
      entries.push(entry);
      modelIndex.set(model, entry);
    }
  }

  return entries;
}
