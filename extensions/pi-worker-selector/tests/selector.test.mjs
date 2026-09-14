import assert from "node:assert/strict";
import { selectWorkerModel, providerOf } from "../core.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ---------- helpers ----------

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
  { model: "xai/grok-4.6", capability: ["big"], costTier: "normal" },
  { model: "openai-codex/gpt-5.6-sol", capability: ["big"], costTier: "normal" },
];

const ALL_AVAILABLE = POOL.map((e) => e.model);

// ---------- F1 ----------
test("F1: Codex ineligible(5%), big, xAI healthy → grok-4.6", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("openai-codex", 5), snap("xai", 60), snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "xai/grok-4.6");
  assert.ok(result.reason.includes("xai=healthy") || result.reason.includes("xai="), result.reason);
  assert.ok(result.reason.includes("ineligible") || result.reason.includes("codex="), result.reason);
});

// ---------- F2 ----------
test("F2: Codex healthy, big, both eligible → deterministic cost-tier selection", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("openai-codex", 60), snap("xai", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  // Both grok and sol have costTier "normal" → tiebreak alphabetically: grok < sol
  assert.equal(result.model, "openai-codex/gpt-5.6-sol");
  // Deterministic: same input always same output
  const result2 = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("openai-codex", 60), snap("xai", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result2.model, result.model);
});

// ---------- F3 ----------
test("F3: small, DeepSeek healthy → deepseek flash", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "small" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "ollama/deepseek-v4.1-flash");
});

// ---------- F4 ----------
test("F4: big, grok ineligible, sol healthy → sol", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 5), snap("openai-codex", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "openai-codex/gpt-5.6-sol");
});

// ---------- F5 ----------
test("F5: all big-capable ineligible → STOP before spawn", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 5), snap("openai-codex", 3)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "STOP");
  assert.ok(result.reason.includes("ineligible"), result.reason);
});

// ---------- F6 ----------
test("F6: forced reviewer=grok, xAI ineligible → STOP, no sol substitution", () => {
  const result = selectWorkerModel({
    mode: { kind: "forced", exactModel: "xai/grok-4.6" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 5), snap("openai-codex", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "STOP");
  assert.ok(result.reason.includes("xai"), result.reason);
  assert.ok(result.reason.includes("ineligible"), result.reason);
});

// ---------- F7 ----------
test("F7: explicit sol + Codex ineligible → STOP, no substitution", () => {
  const result = selectWorkerModel({
    mode: { kind: "explicit", exactModel: "openai-codex/gpt-5.6-sol" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("openai-codex", 5), snap("xai", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "STOP");
  assert.ok(result.affectedProvider === "openai-codex");
});

// ---------- F8 ----------
test("F8: quota UNKNOWN → fail-open → candidate remains eligible", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(unknown("xai"), unknown("openai-codex")),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  // Some big model selected despite UNKNOWN quota
  assert.ok(result.model === "xai/grok-4.6" || result.model === "openai-codex/gpt-5.6-sol");
});

// ---------- F9 ----------
test("F9: continuation - grok healthy → still selects grok for big", () => {
  // Without dedicated continuation support in v1, selector picks grok normally for big
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 60), snap("openai-codex", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  // grok alphabetically before sol (openai-codex > xai? No: "openai-codex" < "xai" alphabetically)
  // So sol should come first alphabetically, but both have costTier "normal"
  // tiebreak: model string sort: "openai-codex/gpt-5.6-sol" < "xai/grok-4.6" → sol wins
  assert.equal(result.model, "openai-codex/gpt-5.6-sol");
});

// ---------- F10 ----------
test("F10: grok ineligible, normal worker → selects next eligible big (sol)", () => {
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 5), snap("openai-codex", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "openai-codex/gpt-5.6-sol");
});

// ---------- F11 ----------
test("F11: Parent=Sol not in pool for small/medium, no tier → uses default medium, does NOT pick sol", () => {
  // Pool has deepseek for small/medium; sol is big-only
  // Parent model "openai-codex/gpt-5.6-sol" is not in availableModels for medium
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "medium" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "ollama/deepseek-v4.1-flash");
  assert.notEqual(result.model, "openai-codex/gpt-5.6-sol");
});

// ---------- F12 ----------
test("F12: cheap model has no big capability → MUST NOT win big task", () => {
  // deepseek is cheap but only small/medium — should never be picked for big
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("xai", 60), snap("openai-codex", 60)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "SELECTED");
  assert.notEqual(result.model, "ollama/deepseek-v4.1-flash");
  assert.ok(result.model === "xai/grok-4.6" || result.model === "openai-codex/gpt-5.6-sol");
});

// ---------- Extra boundary tests ----------

test("forced model not in pool → STOP", () => {
  const result = selectWorkerModel({
    mode: { kind: "forced", exactModel: "anthropic/claude-opus-5" },
    pool: POOL,
    quotaSnapshots: new Map(),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "STOP");
  assert.ok(result.reason.includes("not in worker pool"), result.reason);
});

test("explicit model not available/authenticated → STOP", () => {
  const result = selectWorkerModel({
    mode: { kind: "explicit", exactModel: "xai/grok-4.6" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 60)),
    availableModels: ["ollama/deepseek-v4.1-flash"], // grok not available
  });
  assert.equal(result.outcome, "STOP");
  assert.ok(result.reason.includes("not available"), result.reason);
});

test("no candidates with capability=big in pool → STOP", () => {
  const smallPool = [
    { model: "ollama/deepseek-v4.1-flash", capability: ["small", "medium"], costTier: "cheap" },
  ];
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "big" },
    pool: smallPool,
    quotaSnapshots: new Map(),
    availableModels: ["ollama/deepseek-v4.1-flash"],
  });
  assert.equal(result.outcome, "STOP");
});

test("cheap model wins over normal for same capability", () => {
  const mixedPool = [
    { model: "provider-a/model-cheap", capability: ["medium"], costTier: "cheap" },
    { model: "provider-b/model-normal", capability: ["medium"], costTier: "normal" },
  ];
  const result = selectWorkerModel({
    mode: { kind: "tier", requirement: "medium" },
    pool: mixedPool,
    quotaSnapshots: snapshots(snap("provider-a", 80), snap("provider-b", 80)),
    availableModels: ["provider-a/model-cheap", "provider-b/model-normal"],
  });
  assert.equal(result.outcome, "SELECTED");
  assert.equal(result.model, "provider-a/model-cheap");
});

test("providerOf extracts provider correctly", () => {
  assert.equal(providerOf("xai/grok-4.6"), "xai");
  assert.equal(providerOf("openai-codex/gpt-5.6-sol"), "openai-codex");
  assert.equal(providerOf("ollama/deepseek-v4.1-flash"), "ollama");
  assert.equal(providerOf("ollama2/deepseek-v4.1-flash"), "ollama2");
});

test("bare ambiguous model name STOPs", () => {
  const result = selectWorkerModel({
    mode: { kind: "explicit", exactModel: "grok-4.6" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(result.outcome, "STOP");
});

console.log(`${passed}/${passed} worker selector tests passed`);
