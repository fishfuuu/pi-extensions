/**
 * Seam canary: DW applyPreSpawnModel + our resolver.
 * Does not call a provider. Live createAgentSession canaries are opt-in via
 * PI_WORKER_SELECTOR_LIVE_CANARY=1 (not run by default).
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { decidePreSpawn, installProcessResolver } from "../resolve.ts";

async function loadDw() {
  const roots = [
    "@quintinshaw/pi-dynamic-workflows",
    pathToFileURL(
      "C:/Users/Administrator/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/dist/pre-spawn-model.js",
    ).href,
  ];
  for (const spec of roots) {
    try {
      const mod = await import(spec);
      if (mod.applyPreSpawnModel && mod.setPreSpawnModelResolver) return mod;
    } catch {
      /* try next */
    }
  }
  return null;
}

const POOL = [
  { model: "ollama/deepseek-v4.1-flash", capability: ["small", "medium"], costTier: "cheap" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "normal" },
];
const ALL = POOL.map((e) => e.model);
function snap(provider, remainingPct) {
  return {
    provider,
    windows: [{ label: "5h", remainingPct }],
    tightestRemainingPct: remainingPct,
    status: remainingPct <= 10 ? "INELIGIBLE" : "HEALTHY",
    observedAt: Date.now(),
  };
}

const dw = await loadDw();
if (!dw?.applyPreSpawnModel || !dw?.setPreSpawnModelResolver) {
  console.log("SKIP canary: @quintinshaw/pi-dynamic-workflows >=3.11.0 not importable");
  process.exit(0);
}

const parentBefore = "openai-codex/gpt-5.6-sol";

function makeResolver(quota) {
  return async (ctx) =>
    decidePreSpawn(ctx, {
      pool: POOL,
      quotaSnapshots: new Map(quota.map((s) => [s.provider, s])),
      availableModels: ALL,
    });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test("C1 default unchanged via applyPreSpawnModel", async () => {
  const resolver = makeResolver([snap("ollama", 80)]);
  dw.setPreSpawnModelResolver(resolver);
  installProcessResolver(resolver);
  const d = await dw.applyPreSpawnModel(resolver, {
    modelSource: "default",
    resolvedModel: "ollama/deepseek-v4.1-flash",
    tier: "medium",
  });
  assert.equal(d.action, "unchanged");
});

await test("C2 no capable fallback → applyPreSpawnModel throws reject", async () => {
  const resolver = makeResolver([snap("xai", 5), snap("ollama", 80)]);
  await assert.rejects(
    () =>
      dw.applyPreSpawnModel(resolver, {
        modelSource: "tier",
        tier: "big",
        resolvedModel: "xai/grok-4.6",
      }),
    (err) => err.code === "MODEL_SPAWN_REJECTED",
  );
});

await test("C2b tier fallback when capable alternate exists", async () => {
  const pool = [
    ...POOL,
    { model: "openai-codex/gpt-5.6-sol", capability: ["big"], costTier: "normal" },
  ];
  const resolver = async (ctx) =>
    decidePreSpawn(ctx, {
      pool,
      quotaSnapshots: new Map([
        ["xai", snap("xai", 5)],
        ["openai-codex", snap("openai-codex", 60)],
      ]),
      availableModels: pool.map((e) => e.model),
    });
  const d = await dw.applyPreSpawnModel(resolver, {
    modelSource: "tier",
    tier: "big",
    resolvedModel: "xai/grok-4.6",
  });
  assert.equal(d.action, "use");
  assert.equal(d.model, "openai-codex/gpt-5.6-sol");
});

await test("C3 explicit low rejects and throws MODEL_SPAWN_REJECTED", async () => {
  const resolver = makeResolver([snap("xai", 4)]);
  await assert.rejects(
    () =>
      dw.applyPreSpawnModel(resolver, {
        modelSource: "explicit",
        requestedModel: "xai/grok-4.6",
        resolvedModel: "xai/grok-4.6",
      }),
    (err) => {
      assert.equal(err.code, "MODEL_SPAWN_REJECTED");
      return true;
    },
  );
});

await test("C4 quota UNKNOWN fail-open", async () => {
  const resolver = makeResolver([
    {
      provider: "ollama",
      windows: [],
      tightestRemainingPct: undefined,
      status: "UNKNOWN",
      observedAt: Date.now(),
    },
  ]);
  const d = await dw.applyPreSpawnModel(resolver, {
    modelSource: "default",
    resolvedModel: "ollama/deepseek-v4.1-flash",
  });
  assert.equal(d.action, "unchanged");
});

await test("C5 selector failure rejects, does not inherit parent", async () => {
  const resolver = async () => {
    throw new Error("boom");
  };
  await assert.rejects(() =>
    dw.applyPreSpawnModel(resolver, { modelSource: "session" }),
  );
});

await test("C6 parent model invariant (resolver never returns parent unless in pool)", async () => {
  const resolver = makeResolver([snap("ollama", 80)]);
  const d = await dw.applyPreSpawnModel(resolver, { modelSource: "session" });
  assert.equal(d.action, "use");
  assert.notEqual(d.model, parentBefore);
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
});

await test("C-typo-tier: unconfigured tier with resolvedModel=Parent must reject", async () => {
  const resolver = makeResolver([snap("openai-codex", 90), snap("ollama", 80)]);
  await assert.rejects(
    () =>
      dw.applyPreSpawnModel(resolver, {
        modelSource: "tier",
        tier: "mdium",
        resolvedModel: parentBefore,
      }),
    (err) => err.code === "MODEL_SPAWN_REJECTED" && String(err.message).includes("mdium"),
  );
});

console.log(`${passed}/${passed} worker-selector canaries passed`);
console.log("LIVE createAgentSession canaries not run (no provider call in this seam canary).");
