import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAgentModel, readAgentProfileModel, tierMode } from "../agent-tool.ts";

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
  { model: "ollama-copy/deepseek-v4.1-flash", capability: ["medium"], costTier: "normal" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "cheap" },
];

const ALL_AVAILABLE = POOL.map((e) => e.model);

// ---------- guard mode (default) ----------

test("guard: healthy provider leaves the profile pin alone", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("zai-coding-cn", 70)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(d.action, "unchanged");
  assert.match(d.reason, /guard inactive/);
});

test("guard: unknown provider fails open", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(unknown("zai-coding-cn")),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(d.action, "unchanged");
  assert.match(d.reason, /UNKNOWN/);
});

test("guard: ineligible provider swaps in the cheapest eligible capable model", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("zai-coding-cn", 3), snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
});

test("guard: no resolved model means nothing to guard", () => {
  const d = decideAgentModel({
    currentModel: undefined,
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 2)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(d.action, "unchanged");
  assert.match(d.reason, /parent inherit/);
});

test("guard: ineligible with no eligible replacement stays unchanged (never blocks)", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("zai-coding-cn", 3), snap("ollama", 4), snap("ollama-copy", 2)),
    availableModels: ALL_AVAILABLE,
  });
  assert.equal(d.action, "unchanged");
  assert.match(d.reason, /no eligible replacement/);
});

// ---------- policy mode ----------

test("policy: routes a healthy profile pin through the pool anyway", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("zai-coding-cn", 70), snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
    mode: "policy",
  });
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama/deepseek-v4.1-flash");
});

test("policy: already-selected model reports unchanged", () => {
  const d = decideAgentModel({
    currentModel: "ollama/deepseek-v4.1-flash:high",
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80)),
    availableModels: ALL_AVAILABLE,
    mode: "policy",
  });
  assert.equal(d.action, "unchanged");
  assert.match(d.reason, /already selects/);
});

test("policy: unavailable pool candidates are skipped", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama-copy", 90)),
    availableModels: ["ollama-copy/deepseek-v4.1-flash"],
    mode: "policy",
  });
  assert.equal(d.action, "use");
  assert.equal(d.model, "ollama-copy/deepseek-v4.1-flash");
});

// ---------- tier mapping ----------

test("tierMode: capability tiers pass through", () => {
  assert.deepEqual(tierMode("small", {}), { kind: "tier", requirement: "small" });
  assert.deepEqual(tierMode(undefined, {}), { kind: "tier", requirement: "medium" });
});

test("tierMode: a custom tier name resolves to its pinned model", () => {
  assert.deepEqual(tierMode("deep", { deep: "xai/grok-4.6" }), {
    kind: "explicit",
    exactModel: "xai/grok-4.6",
  });
});

test("tierMode: an unknown custom tier falls back to medium, not to a bigger tier", () => {
  assert.deepEqual(tierMode("typo", { big: "xai/grok-4.6" }), {
    kind: "tier",
    requirement: "medium",
  });
});

test("agentTiers: a profile tier drives the guard's replacement", () => {
  const d = decideAgentModel({
    currentModel: "zai-coding-cn/glm-5.3",
    pool: POOL,
    quotaSnapshots: snapshots(snap("zai-coding-cn", 3), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    tier: "big",
  });
  assert.equal(d.action, "use");
  assert.equal(d.model, "xai/grok-4.6");
});

// ---------- profile frontmatter ----------

test("readAgentProfileModel: reads the frontmatter model", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(
    join(dir, "code-reviewer.md"),
    ["---", "name: code-reviewer", "model: zai-coding-cn/glm-5.3", "---", "", "body"].join("\n"),
  );
  assert.equal(readAgentProfileModel("code-reviewer", dir), "zai-coding-cn/glm-5.3");
});

test("readAgentProfileModel: no frontmatter, no file, and bad names return undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(dir, "plain.md"), "no frontmatter here");
  assert.equal(readAgentProfileModel("plain", dir), undefined);
  assert.equal(readAgentProfileModel("missing", dir), undefined);
  assert.equal(readAgentProfileModel("../secrets", dir), undefined);
  assert.equal(readAgentProfileModel(undefined, dir), undefined);
});

console.log(`${passed}/${passed} pi-worker-selector agent-tool tests passed`);
