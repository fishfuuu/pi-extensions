/**
 * pi-worker-selector — process-level DW preSpawn model resolver.
 *
 * Registers one process-wide resolver via the DW v3.11.0 globalThis slot
 * (same slot as setPreSpawnModelResolver). Affects DW worker spawn only.
 * Does not modify the Parent session model. Does not register an LLM tool.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { QuotaSnapshot } from "../pi-quota/snapshot.ts";
import { loadWorkerSelectorConfig } from "./config.ts";
import { createAgentToolHandler } from "./agent-tool.ts";
import {
  decidePreSpawn,
  installProcessResolver,
  type PreSpawnModelContext,
  type PreSpawnModelDecision,
} from "./resolve.ts";

type RegistryLike = {
  getAvailable?: () => Array<{ provider: string; id: string }>;
};

type QuotaModule = typeof import("../pi-quota/snapshot.ts");

/**
 * pi-quota is an optional companion. Import it lazily so this extension still
 * loads without it. Routing then runs with no quota snapshots, which the
 * selector treats as UNKNOWN and fail-open: it keeps filtering by capability,
 * availability and cost rather than failing every spawn.
 */
let quotaModule: QuotaModule | null | undefined;
async function loadQuotaModule(): Promise<QuotaModule | null> {
  if (quotaModule !== undefined) return quotaModule;
  try {
    quotaModule = await import("../pi-quota/snapshot.ts");
  } catch {
    quotaModule = null;
    console.warn(
      "[pi-worker-selector] pi-quota not found; worker routing continues without quota filtering. " +
        "Install it (pi install git:github.com/fishfuuu/pi-extensions) for quota-aware routing.",
    );
  }
  return quotaModule;
}

function availableFromRegistry(registry: RegistryLike | undefined, poolModels: string[]): string[] {
  if (!registry?.getAvailable) return poolModels;
  try {
    return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return poolModels;
  }
}

export default function (pi: ExtensionAPI): void {
  let registry: RegistryLike | undefined;

  const capture = (_event: unknown, ctx: ExtensionContext): void => {
    registry = ctx.modelRegistry;
  };
  pi.on("session_start", capture);
  pi.on("before_agent_start", capture);

  /**
   * Built-in Agent adapter: pi-web resolves the child model as tool argument →
   * profile frontmatter → parent, and exposes no pre-spawn seam. A `tool_call`
   * handler may mutate `event.input`, which is the documented way to change the
   * arguments, so the guard/policy decision is applied there instead.
   */
  const agentToolHandler = createAgentToolHandler({
    loadConfig: () => loadWorkerSelectorConfig(),
    loadSnapshots: async (policy) => {
      const quota = await loadQuotaModule();
      if (!quota) return new Map<string, QuotaSnapshot>();
      let snapshots: Map<string, QuotaSnapshot> = new Map();
      if (registry) {
        snapshots = await quota.fetchAllQuotaSnapshots(
          registry as Parameters<QuotaModule["fetchAllQuotaSnapshots"]>[0],
          policy,
        );
      }
      if (snapshots.size === 0) snapshots = quota.getCachedSnapshots(policy);
      return snapshots;
    },
    availableModels: (poolModels) => availableFromRegistry(registry, poolModels),
    agentsDir: join(getAgentDir(), "agents"),
  });
  pi.on("tool_call", (event, ctx) => agentToolHandler(event, ctx));

  const resolver = async (ctx: PreSpawnModelContext): Promise<PreSpawnModelDecision> => {
    try {
      const { pool, quotaPolicy, tiers } = loadWorkerSelectorConfig();
      const quota = await loadQuotaModule();
      let quotaSnapshots: Map<string, QuotaSnapshot> = new Map();
      if (quota) {
        if (registry) {
          quotaSnapshots = await quota.fetchAllQuotaSnapshots(
            registry as Parameters<QuotaModule["fetchAllQuotaSnapshots"]>[0],
            quotaPolicy,
          );
        }
        if (quotaSnapshots.size === 0) {
          quotaSnapshots = quota.getCachedSnapshots(quotaPolicy);
        }
      }
      return decidePreSpawn(ctx, {
        pool,
        quotaSnapshots,
        availableModels: availableFromRegistry(registry, pool.map((e) => e.model)),
        tiers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { action: "reject", reason: `selector internal error: ${message}` };
    }
  };

  installProcessResolver(resolver);
  void import("@quintinshaw/pi-dynamic-workflows")
    .then((dw) => {
      dw.setPreSpawnModelResolver?.(resolver);
    })
    .catch(() => {
      /* slot already set; DW may load later and read the same Symbol */
    });
}
