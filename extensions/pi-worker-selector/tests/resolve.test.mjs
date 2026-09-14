import assert from "node:assert/strict";
import { applyStale } from "../../pi-quota/snapshot.ts";
import { isConcreteModelSpec, providerOf, stripThinkingSuffix } from "../core.ts";
import {
  PROCESS_RESOLVER_SLOT,
  decidePreSpawn,
  installProcessResolver,
  modeFromSource,
} from "../resolve.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function snap(provider, remainingPct, status = remainingPct <= 10 ? "INELIGIBLE" : "HEALTHY") {
  return { provider, windows: [{ label: "5h", remainingPct }], tightestRemainingPct: remainingPct, status, observedAt: Date.now() };
}
function unknown(provider) {
  return { provider, windows: [], tightestRemainingPct: undefined, status: "UNKNOWN", observedAt: Date.now() };
}
function snapshots(...entries) {
  return new Map(entries.map((e) => [e.provider, e]));
}

const POOL = [
  { model: "ollama/deepseek-v4.1-flash", capability: ["small", "medium"], costTier: "cheap" },
  { model: "ollama2/deepseek-v4.1-flash", capability: ["small", "medium"], costTier: "cheap" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "normal" },
  { model: "openai-codex/gpt-5.6-sol", capability: ["big"], costTier: "normal" },
];
const ALL = POOL.map((e) => e.model);

const TIERS = {
  small: "ollama/deepseek-v4.1-flash",
  medium: "ollama/deepseek-v4.1-flash",
  big: "xai/grok-4.6",
  review: "xai/grok-4.6",
};

function input(quota, tiers = TIERS) {
  return { pool: POOL, quotaSnapshots: quota, availableModels: ALL, tiers };
}

/** Mirror DW resolveAgentModelSpec: resolveTierModel(tier) ?? mainModel */
function resolveAgentModelSpecLike(tier, tiers, mainModel) {
  return tiers[tier] ?? mainModel;
}

test("F1 default matching healthy resolved → unchanged", () => {
  const d = decidePreSpawn(
    { modelSource: "default", resolvedModel: "ollama/deepseek-v4.1-flash", tier: "medium" },
    input(snapshots(snap("ollama", 80))),
  );
  assert.equal(d.action, "unchanged");
});

test("F2 tier → healthy preferred candidate", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "small", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("ollama", 80), snap("xai", 60))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
});

test("F3 tier preferred low → fallback healthy capable", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 5), snap("openai-codex", 60))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "openai-codex/gpt-5.6-sol");
});

test("F4 all capable low → reject", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 5), snap("openai-codex", 3))),
  );
  assert.equal(d.action, "reject");
});

test("F5 explicit low → reject, no substitution", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 5), snap("openai-codex", 60))),
  );
  assert.equal(d.action, "reject");
  assert.ok(d.reason.includes("xai"));
});

test("F6 forced reviewer low → reject (explicit, no substitution)", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6", label: "reviewer" },
    input(snapshots(snap("xai", 5), snap("openai-codex", 60))),
  );
  assert.equal(d.action, "reject");
});

test("F7 quota UNKNOWN → fail-open", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium", resolvedModel: "ollama/deepseek-v4.1-flash" },
    input(snapshots(unknown("ollama"))),
  );
  assert.equal(d.action, "unchanged");
});

test("F8 stale healthy → UNKNOWN / fail-open", () => {
  const staleHealthy = applyStale(snap("ollama", 80, "HEALTHY"));
  assert.equal(staleHealthy.status, "UNKNOWN");
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium", resolvedModel: "ollama/deepseek-v4.1-flash" },
    input(snapshots(staleHealthy)),
  );
  assert.equal(d.action, "unchanged");
});

test("F9 stale last-low → still ineligible", () => {
  const staleLow = applyStale(snap("xai", 5, "INELIGIBLE"));
  assert.equal(staleLow.status, "INELIGIBLE");
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6" },
    input(snapshots(staleLow, snap("openai-codex", 60))),
  );
  assert.equal(d.action, "reject");
});

test("F10 selector internal error → reject, no parent inherit", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium" },
    { pool: null, quotaSnapshots: new Map(), availableModels: ALL },
  );
  assert.equal(d.action, "reject");
  assert.ok(d.reason.includes("internal error"));
});

test("F11 no valid candidate → reject", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big" },
    {
      pool: [{ model: "ollama/deepseek-v4.1-flash", capability: ["small"], costTier: "cheap" }],
      quotaSnapshots: new Map(),
      availableModels: ["ollama/deepseek-v4.1-flash"],
    },
  );
  assert.equal(d.action, "reject");
});

test("F12 session never inherits parent — use pool model", () => {
  const d = decidePreSpawn(
    { modelSource: "session", resolvedModel: undefined },
    input(snapshots(snap("ollama", 80))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
  assert.notEqual(d.model, "openai-codex/gpt-5.6-sol");
});

test("R2 unchanged preserves DW-selected model", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 60))),
  );
  assert.equal(d.action, "unchanged");
});

test("R3 use overrides resolved worker model", () => {
  const d = decidePreSpawn(
    { modelSource: "default", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("ollama", 80), snap("xai", 60))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
});

test("R4 reject prevents spawn (decision only)", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 4))),
  );
  assert.equal(d.action, "reject");
});

test("R5 explicit source no substitution", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 4), snap("openai-codex", 90))),
  );
  assert.equal(d.action, "reject");
});

test("R7 decision does not leak quota snapshot objects", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "small", resolvedModel: "ollama/deepseek-v4.1-flash" },
    input(snapshots(snap("ollama", 80))),
  );
  assert.equal(JSON.stringify(d).includes("windows"), false);
  assert.equal(JSON.stringify(d).includes("observedAt"), false);
});

test("R1/R8 process resolver slot is the DW globalThis symbol", () => {
  const fn = () => ({ action: "unchanged" });
  installProcessResolver(fn);
  assert.equal(globalThis[PROCESS_RESOLVER_SLOT], fn);
});

test("phase is treated as explicit pin", () => {
  const mode = modeFromSource({ modelSource: "phase", requestedModel: "xai/grok-4.6" });
  assert.equal(mode.kind, "explicit");
  const d = decidePreSpawn(
    { modelSource: "phase", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 5), snap("openai-codex", 80))),
  );
  assert.equal(d.action, "reject");
});

test("unknown/typo tier rejects even when DW resolvedModel is Parent mainModel", () => {
  const parent = "openai-codex/gpt-5.6-sol";
  const resolved = resolveAgentModelSpecLike("mdium", TIERS, parent);
  assert.equal(resolved, parent);
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "mdium", resolvedModel: resolved },
    input(snapshots(snap("openai-codex", 90), snap("ollama", 80), snap("xai", 80))),
  );
  assert.equal(d.action, "reject");
  assert.ok(d.reason.includes("mdium"));
  assert.notEqual(d.model, parent);
});

test("unconfigured custom tier (review missing from file) rejects, does not spawn Parent", () => {
  const parent = "openai-codex/gpt-5.6-sol";
  const tiers = { small: TIERS.small, medium: TIERS.medium, big: TIERS.big };
  const resolved = resolveAgentModelSpecLike("review", tiers, parent);
  assert.equal(resolved, parent);
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "review", resolvedModel: resolved },
    input(snapshots(snap("openai-codex", 90), snap("xai", 80)), tiers),
  );
  assert.equal(d.action, "reject");
});

test("configured custom tier pins file mapping and applies quota", () => {
  const healthy = decidePreSpawn(
    { modelSource: "tier", tier: "review", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 80))),
  );
  assert.equal(healthy.action, "unchanged");
  const low = decidePreSpawn(
    { modelSource: "tier", tier: "review", resolvedModel: "xai/grok-4.6" },
    input(snapshots(snap("xai", 4), snap("openai-codex", 90))),
  );
  assert.equal(low.action, "reject");
  assert.ok(low.reason.includes("xai"));
});

test("bare model name is rejected", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "grok-4.6" },
    input(snapshots(snap("xai", 80))),
  );
  assert.equal(d.action, "reject");
  assert.equal(isConcreteModelSpec("grok-4.6"), false);
  assert.equal(isConcreteModelSpec("xai/grok-4.6:high"), true);
  assert.equal(stripThinkingSuffix("xai/grok-4.6:high"), "xai/grok-4.6");
  assert.equal(stripThinkingSuffix("ollama/deepseek-v4.1-flash"), "ollama/deepseek-v4.1-flash");
  assert.equal(stripThinkingSuffix("ollama/custom-id:0731"), "ollama/custom-id:0731");
});

test("C7 ollama vs ollama2 are separate quota pools", () => {
  assert.equal(providerOf("ollama/deepseek-v4.1-flash"), "ollama");
  assert.equal(providerOf("ollama2/deepseek-v4.1-flash"), "ollama2");
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "ollama2/deepseek-v4.1-flash" },
    input(snapshots(snap("ollama", 5), snap("ollama2", 80))),
  );
  assert.equal(d.action, "unchanged");
});

const ROUTING_POOL = [
  { model: "ollama/glm-5.3-flash", capability: ["small"], costTier: "cheap" },
  { model: "ollama2/glm-5.3-flash", capability: ["small"], costTier: "cheap" },
  { model: "ollama/deepseek-v4.1-flash", capability: ["medium"], costTier: "cheap" },
  { model: "ollama2/deepseek-v4.1-flash", capability: ["medium"], costTier: "cheap" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "cheap" },
  { model: "ollama/glm-5.3", capability: ["big"], costTier: "normal" },
  { model: "ollama2/glm-5.3", capability: ["big"], costTier: "normal" },
];
const ROUTING_ALL = ROUTING_POOL.map((e) => e.model);
const ROUTING_TIERS = {
  small: "ollama/glm-5.3-flash",
  medium: "ollama/deepseek-v4.1-flash",
  big: "xai/grok-4.6",
};
function routing(quota) {
  return {
    pool: ROUTING_POOL,
    quotaSnapshots: quota,
    availableModels: ROUTING_ALL,
    tiers: ROUTING_TIERS,
  };
}
function healthyAll() {
  return snapshots(
    snap("ollama", 80),
    snap("ollama2", 80),
    snap("xai", 80),
  );
}
function picked(d) {
  return d.action === "use" ? d.model : d.action === "unchanged" ? undefined : null;
}

test("S1 small healthy → ollama/glm-5.3-flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "small", resolvedModel: "ollama/glm-5.3-flash" },
    routing(healthyAll()),
  );
  assert.equal(d.action, "unchanged");
});

test("S2 small primary low → ollama2/glm-5.3-flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "small", resolvedModel: "ollama/glm-5.3-flash" },
    routing(snapshots(snap("ollama", 5), snap("ollama2", 80), snap("xai", 80))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama2/glm-5.3-flash");
});

test("S3 small both low → reject, not medium/big", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "small" },
    routing(snapshots(snap("ollama", 5), snap("ollama2", 4), snap("xai", 90))),
  );
  assert.equal(d.action, "reject");
  assert.notEqual(picked(d), "ollama/deepseek-v4.1-flash");
  assert.notEqual(picked(d), "xai/grok-4.6");
});

test("M1 medium healthy → ollama/deepseek-v4.1-flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium", resolvedModel: "ollama/deepseek-v4.1-flash" },
    routing(healthyAll()),
  );
  assert.equal(d.action, "unchanged");
});

test("M2 medium primary low → ollama2/deepseek-v4.1-flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium", resolvedModel: "ollama/deepseek-v4.1-flash" },
    routing(snapshots(snap("ollama", 5), snap("ollama2", 80), snap("xai", 80))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama2/deepseek-v4.1-flash");
});

test("M3 medium both low → reject, not small/big", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "medium" },
    routing(snapshots(snap("ollama", 5), snap("ollama2", 4), snap("xai", 90))),
  );
  assert.equal(d.action, "reject");
});

test("B1 big healthy → xai/grok-4.6", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big", resolvedModel: "xai/grok-4.6" },
    routing(healthyAll()),
  );
  assert.equal(d.action, "unchanged");
});

test("B2 grok low → ollama/glm-5.3, not flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big", resolvedModel: "xai/grok-4.6" },
    routing(snapshots(snap("xai", 5), snap("ollama", 80), snap("ollama2", 80))),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/glm-5.3");
  assert.notEqual(d.model, "ollama/glm-5.3-flash");
});

test("B3 big all low → reject, no flash", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "big" },
    routing(snapshots(snap("xai", 5), snap("ollama", 4), snap("ollama2", 3))),
  );
  assert.equal(d.action, "reject");
});

test("P1 Parent grok is not a medium/small worker fallback", () => {
  const d = decidePreSpawn(
    { modelSource: "default", resolvedModel: "xai/grok-4.6" },
    routing(healthyAll()),
  );
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
  assert.notEqual(d.model, "xai/grok-4.6");
});

test("P2 unknown tier still reject", () => {
  const d = decidePreSpawn(
    { modelSource: "tier", tier: "mdium", resolvedModel: "xai/grok-4.6" },
    routing(healthyAll()),
  );
  assert.equal(d.action, "reject");
});

test("P3 explicit grok low does not substitute glm-5.3", () => {
  const d = decidePreSpawn(
    { modelSource: "explicit", requestedModel: "xai/grok-4.6", resolvedModel: "xai/grok-4.6" },
    routing(snapshots(snap("xai", 5), snap("ollama", 80))),
  );
  assert.equal(d.action, "reject");
});

console.log(`${passed}/${passed} worker-selector resolve tests passed`);
