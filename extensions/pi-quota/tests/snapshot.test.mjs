import assert from "node:assert/strict";
import { cardToSnapshot, evaluateStatus, applyStale, DEFAULT_QUOTA_POLICY } from "../snapshot.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const POLICY = DEFAULT_QUOTA_POLICY; // thresholdPct: 10

// ---- cardToSnapshot ----

test("error card → status UNKNOWN, no windows", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", error: "TIMEOUT", rows: [] }, POLICY);
  assert.equal(snap.status, "UNKNOWN");
  assert.equal(snap.error, "TIMEOUT");
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.tightestRemainingPct, undefined);
});

test("healthy card → status HEALTHY", () => {
  const snap = cardToSnapshot({ providerId: "xai", title: "xAI", rows: [{ label: "5h", usedPct: 30 }] }, POLICY);
  assert.equal(snap.status, "HEALTHY");
  assert.equal(snap.tightestRemainingPct, 70);
  assert.equal(snap.windows[0].remainingPct, 70);
});

test("ineligible card (9% remaining) → status INELIGIBLE", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 91 }] }, POLICY);
  assert.equal(snap.status, "INELIGIBLE");
  assert.equal(snap.tightestRemainingPct, 9);
});

test("exactly 10% remaining → INELIGIBLE (≤ threshold)", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 90 }] }, POLICY);
  assert.equal(snap.status, "INELIGIBLE");
  assert.equal(snap.tightestRemainingPct, 10);
});

test("11% remaining → HEALTHY (above threshold)", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 89 }] }, POLICY);
  assert.equal(snap.status, "HEALTHY");
  assert.equal(snap.tightestRemainingPct, 11);
});

test("multi-window Codex: tightest wins", () => {
  const snap = cardToSnapshot({
    providerId: "codex",
    title: "Codex",
    rows: [
      { label: "5h", usedPct: 40 },  // 60% remaining
      { label: "7d", usedPct: 94 },  // 6% remaining ← tightest
    ],
  }, POLICY);
  assert.equal(snap.tightestRemainingPct, 6);
  assert.equal(snap.status, "INELIGIBLE");
});

test("multi-window: both healthy → tightest picked", () => {
  const snap = cardToSnapshot({
    providerId: "ollama",
    title: "Ollama",
    rows: [
      { label: "5h", usedPct: 50 },   // 50% remaining
      { label: "Weekly", usedPct: 70 }, // 30% remaining ← tightest
    ],
  }, POLICY);
  assert.equal(snap.tightestRemainingPct, 30);
  assert.equal(snap.status, "HEALTHY");
});

test("card with no rows → UNKNOWN", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", rows: [] }, POLICY);
  assert.equal(snap.status, "UNKNOWN");
  assert.equal(snap.tightestRemainingPct, undefined);
});

test("snapshot provider field matches card providerId", () => {
  const snap = cardToSnapshot({ providerId: "xai", title: "xAI", rows: [{ label: "5h", usedPct: 20 }] }, POLICY);
  assert.equal(snap.provider, "xai");
});

test("snapshot does not contain sensitive fields", () => {
  const snap = cardToSnapshot({ providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 50 }] }, POLICY);
  const snapStr = JSON.stringify(snap);
  // No token, apiKey, credential, hash etc.
  assert.ok(!snapStr.includes("apiKey"));
  assert.ok(!snapStr.includes("token"));
  assert.ok(!snapStr.includes("credential"));
});

// ---- evaluateStatus ----

test("evaluateStatus: undefined → UNKNOWN", () => {
  assert.equal(evaluateStatus(undefined, POLICY), "UNKNOWN");
});

test("evaluateStatus: 0% → INELIGIBLE", () => {
  assert.equal(evaluateStatus(0, POLICY), "INELIGIBLE");
});

test("evaluateStatus: threshold boundary = 10% → INELIGIBLE", () => {
  assert.equal(evaluateStatus(10, POLICY), "INELIGIBLE");
});

test("evaluateStatus: 10.1% → HEALTHY (above threshold)", () => {
  // Integer arithmetic: if we get 11% due to rounding, it's healthy
  assert.equal(evaluateStatus(11, POLICY), "HEALTHY");
});

test("evaluateStatus: 100% → HEALTHY", () => {
  assert.equal(evaluateStatus(100, POLICY), "HEALTHY");
});

test("evaluateStatus: custom threshold", () => {
  assert.equal(evaluateStatus(20, { thresholdPct: 25 }), "INELIGIBLE");
  assert.equal(evaluateStatus(30, { thresholdPct: 25 }), "HEALTHY");
});

// ---- applyStale ----

test("applyStale: HEALTHY → UNKNOWN (fail-open)", () => {
  const snap = { provider: "xai", windows: [], tightestRemainingPct: 60, status: "HEALTHY", observedAt: Date.now() };
  const stale = applyStale(snap);
  assert.equal(stale.status, "UNKNOWN");
});

test("applyStale: INELIGIBLE → stays INELIGIBLE (conservative)", () => {
  const snap = { provider: "codex", windows: [], tightestRemainingPct: 5, status: "INELIGIBLE", observedAt: Date.now() };
  const stale = applyStale(snap);
  assert.equal(stale.status, "INELIGIBLE");
});

test("applyStale: UNKNOWN → stays UNKNOWN", () => {
  const snap = { provider: "unknown-prov", windows: [], tightestRemainingPct: undefined, status: "UNKNOWN", observedAt: Date.now() };
  const stale = applyStale(snap);
  assert.equal(stale.status, "UNKNOWN");
});

console.log(`${passed}/${passed} snapshot tests passed`);
