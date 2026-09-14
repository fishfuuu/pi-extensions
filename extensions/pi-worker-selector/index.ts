/**
 * pi-worker-selector — process-level DW preSpawn model resolver.
 *
 * Registers one process-wide resolver via the DW v3.11.0 globalThis slot
 * (same slot as setPreSpawnModelResolver). Affects DW worker spawn only.
 * Does not modify the Parent session model. Does not register an LLM tool.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchAllQuotaSnapshots, getCachedSnapshots } from "../pi-quota/snapshot.ts";
import { loadWorkerSelectorConfig } from "./config.ts";
import {
  decidePreSpawn,
  installProcessResolver,
  type PreSpawnModelContext,
  type PreSpawnModelDecision,
} from "./resolve.ts";

type RegistryLike = {
  getAvailable?: () => Array<{ provider: string; id: string }>;
};

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

  const resolver = async (ctx: PreSpawnModelContext): Promise<PreSpawnModelDecision> => {
    try {
      const { pool, quotaPolicy, tiers } = loadWorkerSelectorConfig();
      let quotaSnapshots = new Map();
      if (registry) {
        quotaSnapshots = await fetchAllQuotaSnapshots(
          registry as Parameters<typeof fetchAllQuotaSnapshots>[0],
          quotaPolicy,
        );
      }
      if (quotaSnapshots.size === 0) {
        quotaSnapshots = getCachedSnapshots(quotaPolicy);
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
