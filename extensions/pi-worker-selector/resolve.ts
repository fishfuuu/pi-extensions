/**
 * Map DW PreSpawnModelContext → selector policy → DW decision.
 * Pure. No I/O. Quota snapshots and pool are caller-provided.
 */
import {
  isConcreteModelSpec,
  selectWorkerModel,
  stripThinkingSuffix,
  type CapabilityTier,
  type PoolEntry,
  type SelectorResult,
  type WorkerMode,
} from "./core.ts";
import type { QuotaSnapshot } from "../pi-quota/snapshot.ts";

export type ModelSource = "explicit" | "tier" | "phase" | "default" | "session";

export interface PreSpawnModelContext {
  requestedModel?: string;
  requestedThinking?: string;
  tier?: string;
  resolvedModel?: string;
  modelSource: ModelSource;
  label?: string;
}

export type PreSpawnModelDecision =
  | { action: "unchanged" }
  | { action: "use"; model: string }
  | { action: "reject"; reason: string };

export interface ResolveInput {
  pool: PoolEntry[];
  quotaSnapshots: Map<string, QuotaSnapshot>;
  availableModels: string[];
  /** model-tiers.json `tiers` map. Absent/unknown keys must not inherit Parent. */
  tiers?: Record<string, string>;
}

export const PROCESS_RESOLVER_SLOT = Symbol.for(
  "@quintinshaw/pi-dynamic-workflows.preSpawnModelResolver",
);

export function mapTier(tier: string | undefined): CapabilityTier | undefined {
  if (tier === "small" || tier === "medium" || tier === "big") return tier;
  return undefined;
}

export function modeFromSource(
  ctx: PreSpawnModelContext,
  tiers: Record<string, string> = {},
): WorkerMode | { skip: "reject"; reason: string } {
  switch (ctx.modelSource) {
    case "explicit":
    case "phase": {
      const exact = ctx.requestedModel || ctx.resolvedModel || "";
      return { kind: "explicit", exactModel: exact };
    }
    case "tier": {
      const requirement = mapTier(ctx.tier);
      if (requirement) return { kind: "tier", requirement };
      const mapped = ctx.tier ? tiers[ctx.tier] : undefined;
      if (mapped && isConcreteModelSpec(mapped)) {
        // Configured custom tier: pin the *file* mapping, never DW's
        // resolveTierModel ?? mainModel fallback (that is Parent inherit).
        return { kind: "explicit", exactModel: mapped };
      }
      return {
        skip: "reject",
        reason: `unconfigured or unknown tier ${ctx.tier ?? "(none)"}; refusing spawn (would inherit parent/mainModel)`,
      };
    }
    case "default":
      return { kind: "tier", requirement: mapTier(ctx.tier) ?? "medium" };
    case "session":
      // Must not inherit Parent. Treat as implicit medium worker routing.
      return { kind: "tier", requirement: "medium" };
    default:
      return { skip: "reject", reason: `unhandled modelSource` };
  }
}

function sameModel(a: string | undefined, b: string): boolean {
  if (!a) return false;
  return stripThinkingSuffix(a).toLowerCase() === stripThinkingSuffix(b).toLowerCase();
}

/**
 * Convert a selector result into a DW decision.
 * session source never returns unchanged (that would inherit Parent).
 * explicit/phase never substitute: SELECTED is the pinned model or STOP.
 */
export function decisionFromResult(
  ctx: PreSpawnModelContext,
  result: SelectorResult,
): PreSpawnModelDecision {
  if (result.outcome === "STOP") {
    return { action: "reject", reason: result.reason };
  }
  if (ctx.modelSource === "session") {
    return { action: "use", model: result.model };
  }
  const current = ctx.resolvedModel || ctx.requestedModel;
  if (sameModel(current, result.model)) {
    return { action: "unchanged" };
  }
  return { action: "use", model: result.model };
}

export function decidePreSpawn(ctx: PreSpawnModelContext, input: ResolveInput): PreSpawnModelDecision {
  try {
    const mode = modeFromSource(ctx, input.tiers ?? {});
    if ("skip" in mode) {
      return { action: "reject", reason: mode.reason };
    }
    if ((mode.kind === "explicit" || mode.kind === "forced") && !isConcreteModelSpec(mode.exactModel)) {
      return {
        action: "reject",
        reason: `${mode.kind} model is not a concrete provider/id spec: ${mode.exactModel || "(empty)"}`,
      };
    }
    const result = selectWorkerModel({
      mode,
      pool: input.pool,
      quotaSnapshots: input.quotaSnapshots,
      availableModels: input.availableModels,
    });
    return decisionFromResult(ctx, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action: "reject", reason: `selector internal error: ${message}` };
  }
}

export function installProcessResolver(
  resolver: (ctx: PreSpawnModelContext) => PreSpawnModelDecision | Promise<PreSpawnModelDecision>,
): void {
  const g = globalThis as Record<symbol, unknown>;
  g[PROCESS_RESOLVER_SLOT] = resolver;
}
