/**
 * pi-worker-selector → pi-web built-in Agent adapter.
 *
 * pi-web's built-in subagent tool (`Agent`) resolves its child model as
 * `tool argument` → `profile frontmatter model:` → parent session model (verified
 * against the pi-web bundle). There is no pre-spawn resolver seam for it, but a pi
 * `tool_call` handler may mutate `event.input`, so this adapter can rewrite the
 * `model` argument before the subagent starts.
 *
 * Two modes:
 *   - "guard" (default): only acts when the model that would be used sits on a
 *     quota-INELIGIBLE provider; then it swaps in the selector's pick for that
 *     profile's tier. Profile pins keep working while their provider is healthy.
 *   - "policy": routes every Agent call through the pool/tier policy, ignoring
 *     profile pins.
 *
 * Never blocks and never throws: an extension must not break a subagent the user
 * asked for. When no eligible replacement exists the call proceeds untouched and
 * the reason is reported.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isConcreteModelSpec,
  selectWorkerModel,
  stripThinkingSuffix,
  type CapabilityTier,
  type PoolEntry,
  type WorkerMode,
} from "./core.ts";
import type { QuotaSnapshot } from "../pi-quota/snapshot.ts";

/** pi-web registers its built-in subagent tool under this name. */
export const AGENT_TOOL_NAME = "Agent";

export const DEFAULT_AGENT_TIER: CapabilityTier = "medium";

export type AgentRoutingMode = "guard" | "policy";

export interface AgentModelInput {
  /** Model the call would otherwise use: tool argument, else the profile pin. */
  currentModel?: string;
  pool: PoolEntry[];
  quotaSnapshots: Map<string, QuotaSnapshot>;
  availableModels: string[];
  mode?: AgentRoutingMode;
  /** Tier for this profile: a capability tier or a custom name from model-tiers.json. */
  tier?: string;
  /** Raw `tiers` map, used to resolve custom tier names to pinned models. */
  tiers?: Record<string, string>;
}

export type AgentModelDecision =
  | { action: "unchanged"; reason: string }
  | { action: "use"; model: string; reason: string };

/** The slice of worker-selector config this adapter reads. */
export interface AgentToolConfig {
  pool: PoolEntry[];
  quotaPolicy: { thresholdPct: number };
  tiers: Record<string, string>;
  agentRouting: AgentRoutingMode;
  agentTiers: Record<string, string>;
}

/** Injected so the adapter stays testable without a Pi runtime. */
export interface AgentToolDeps {
  loadConfig: () => AgentToolConfig;
  /** Quota snapshots for this call; an empty map means "no quota data". */
  loadSnapshots: (policy: { thresholdPct: number }) => Promise<Map<string, QuotaSnapshot>>;
  /** Authenticated + available model specs, given the pool specs as a fallback. */
  availableModels: (poolModels: string[]) => string[];
  /** Directory holding agent profiles (`<profile>.md`). */
  agentsDir: string;
}

export interface AgentToolContext {
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
}

/**
 * `tool_call` handler for the built-in Agent tool. Mutates `event.input.model`
 * when the guard/policy decision says so and never blocks or throws.
 */
export function createAgentToolHandler(deps: AgentToolDeps) {
  return async (
    event: { toolName?: string; input?: unknown },
    ctx?: AgentToolContext,
  ): Promise<undefined> => {
    if (event.toolName !== AGENT_TOOL_NAME) return undefined;
    try {
      const input = event.input as Record<string, unknown> | undefined;
      if (!input || typeof input !== "object") return undefined;

      const config = deps.loadConfig();
      const profile = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
      const argModel =
        typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
      const currentModel = argModel ?? readAgentProfileModel(profile, deps.agentsDir);

      const decision = decideAgentModel({
        currentModel,
        pool: config.pool,
        quotaSnapshots: await deps.loadSnapshots(config.quotaPolicy),
        availableModels: deps.availableModels(config.pool.map((e) => e.model)),
        mode: config.agentRouting,
        tier: profile ? config.agentTiers[profile] : undefined,
        tiers: config.tiers,
      });

      if (decision.action === "use") {
        // Mutating event.input in place is how pi replaces tool arguments.
        input.model = decision.model;
        ctx?.ui?.notify?.(
          `[worker-selector] ${profile ?? "agent"}: ${currentModel ?? "(parent)"} → ${decision.model} · ${decision.reason}`,
          "info",
        );
      }
    } catch {
      // Never break a subagent the user asked for.
    }
    return undefined;
  };
}

function providerOfSpec(spec: string): string {
  return stripThinkingSuffix(spec).split("/")[0];
}

function sameSpec(a: string, b: string): boolean {
  return stripThinkingSuffix(a).toLowerCase() === stripThinkingSuffix(b).toLowerCase();
}

/**
 * Tier requirement for a profile. Unknown/absent tiers fall back to `medium`
 * rather than to the DW `tiers` default, so a missing config cannot silently
 * route a worker as "big".
 */
export function tierMode(
  tier: string | undefined,
  tiers: Record<string, string> = {},
): WorkerMode {
  if (tier === "small" || tier === "medium" || tier === "big") {
    return { kind: "tier", requirement: tier };
  }
  const mapped = tier ? tiers[tier] : undefined;
  if (mapped && isConcreteModelSpec(mapped)) {
    return { kind: "explicit", exactModel: mapped };
  }
  return { kind: "tier", requirement: DEFAULT_AGENT_TIER };
}

export function decideAgentModel(input: AgentModelInput): AgentModelDecision {
  try {
    const mode: AgentRoutingMode = input.mode ?? "guard";
    const current = input.currentModel?.trim() || undefined;
    const currentProvider = current ? providerOfSpec(current) : undefined;
    const currentStatus = currentProvider ? input.quotaSnapshots.get(currentProvider)?.status : undefined;

    if (mode === "guard") {
      if (!current) {
        return { action: "unchanged", reason: "no model resolved (parent inherit); nothing to guard" };
      }
      if (currentStatus !== "INELIGIBLE") {
        return {
          action: "unchanged",
          reason: `${currentProvider}=${currentStatus ?? "unknown"}; guard inactive`,
        };
      }
    }

    const selection = selectWorkerModel({
      mode: tierMode(input.tier, input.tiers ?? {}),
      pool: input.pool,
      quotaSnapshots: input.quotaSnapshots,
      availableModels: input.availableModels,
    });

    if (selection.outcome === "STOP") {
      return { action: "unchanged", reason: `no eligible replacement (${selection.reason})` };
    }
    if (current && sameSpec(current, selection.model)) {
      return { action: "unchanged", reason: `policy already selects ${selection.model}` };
    }
    return { action: "use", model: selection.model, reason: selection.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action: "unchanged", reason: `agent adapter error: ${message}` };
  }
}

/**
 * Frontmatter `model:` of an agent profile (`<agentsDir>/<profile>.md`).
 * Undefined when the profile, the frontmatter, or the key is absent.
 */
export function readAgentProfileModel(
  profile: string | undefined,
  agentsDir: string,
): string | undefined {
  if (!profile || !/^[\w.-]+$/.test(profile)) return undefined;
  try {
    const file = join(agentsDir, `${profile}.md`);
    if (!existsSync(file)) return undefined;
    const frontmatter = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return undefined;
    const line = frontmatter[1]
      .split(/\r?\n/)
      .find((entry) => /^model\s*:/.test(entry.trim()));
    if (!line) return undefined;
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}
