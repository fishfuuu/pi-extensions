/**
 * pi-worker-selector → pi-subagents delegation adapter.
 *
 * Pure unit coverage for the selection → delegation-request seam. This file never
 * spawns a subagent and never needs a Pi host: the structured delegation API
 * requires an active extension context (docs/extension-api.md#structured-delegation-api),
 * so the real child run is verified end-to-end by an operator-run canary harness
 * that is not part of this package.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DELEGATION_REQUEST_EVENT,
  DELEGATION_RESPONSE_EVENT,
  buildDelegationRequest,
  delegateSelectedSubagent,
} from "../subagents.ts";
import { selectWorkerModel } from "../core.ts";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ---------- helpers ----------

function snap(provider, remainingPct, status = remainingPct <= 10 ? "INELIGIBLE" : "HEALTHY") {
  return {
    provider,
    windows: [{ label: "5h", remainingPct }],
    tightestRemainingPct: remainingPct,
    status,
    observedAt: Date.now(),
  };
}

function snapshots(...entries) {
  return new Map(entries.map((e) => [e.provider, e]));
}

/** The README's documented worker pool: exclusive capability lists, ollama/ollama2 as separate quota pools. */
const POOL = [
  { model: "ollama/glm-5.3-flash", capability: ["small"], costTier: "cheap" },
  { model: "ollama2/glm-5.3-flash", capability: ["small"], costTier: "cheap" },
  { model: "ollama/deepseek-v4.1-flash", capability: ["medium"], costTier: "cheap" },
  { model: "ollama2/deepseek-v4.1-flash", capability: ["medium"], costTier: "cheap" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "cheap" },
  { model: "ollama/glm-5.3", capability: ["big"], costTier: "normal" },
];
const ALL_AVAILABLE = POOL.map((e) => e.model);

/** The parent session's own model. Deliberately not in the worker pool. */
const PARENT_MODEL = "openai-codex/gpt-5.6-sol";

const SPEC = {
  requestId: "req-1",
  ownerRunId: "run-1",
  nodeId: "node-1",
  agent: "worker",
  task: "Report the model you are running as.",
  context: "fresh",
  cwd: "E:/pi-extensions",
};

const EXPECTED_REQUEST_KEYS = [
  "agent",
  "context",
  "cwd",
  "model",
  "nodeId",
  "ownerRunId",
  "requestId",
  "result",
  "task",
];

function tier(requirement) {
  return { kind: "tier", requirement };
}

/**
 * Minimal event-bus recorder. `respond` turns the emitted request into a terminal
 * response, or returns undefined to stay silent (timeout path).
 */
function recorder(respond) {
  const emitted = [];
  const handlers = new Map();
  return {
    transport: {
      emit(event, payload) {
        emitted.push({ event, payload });
        if (event !== DELEGATION_REQUEST_EVENT || !respond) return;
        const response = respond(payload);
        if (!response) return;
        for (const handler of handlers.get(DELEGATION_RESPONSE_EVENT) ?? []) handler(response);
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return () => {
          const list = handlers.get(event) ?? [];
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        };
      },
    },
    requests: () => emitted.filter((e) => e.event === DELEGATION_REQUEST_EVENT).map((e) => e.payload),
    emitCount: () => emitted.length,
  };
}

function completed(request, model) {
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: "completed",
    model,
  };
}

// ---------- A: small ----------

await test("A: small tier routes to the small worker and the request carries that model", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("small"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "DELEGATED");
  const [request] = rec.requests();
  assert.equal(request.model, "ollama/glm-5.3-flash");
  assert.equal(outcome.model, request.model);

  // The request is the only thing the selector decides; everything else is passthrough.
  assert.deepEqual(Object.keys(request).sort(), EXPECTED_REQUEST_KEYS);
  assert.deepEqual(request.result, { kind: "text" });
  assert.equal(request.agent, SPEC.agent);
  assert.equal(request.context, SPEC.context);
  assert.equal(request.cwd, SPEC.cwd);
});

// ---------- B: medium ----------

await test("B: medium tier routes to the medium worker and the request carries that model", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "DELEGATED");
  const [request] = rec.requests();
  assert.equal(request.model, "ollama/deepseek-v4.1-flash");
  assert.equal(outcome.model, request.model);
});

// ---------- C: big ----------

await test("C: big tier routes to the big worker and the request carries that model", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("big"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "DELEGATED");
  const [request] = rec.requests();
  assert.equal(request.model, "xai/grok-4.6");
  assert.equal(outcome.model, request.model);
});

// ---------- D: quota fallback ----------

await test("D: low primary quota delegates the same-tier fallback, not the primary", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 4), snap("ollama2", 70), snap("xai", 70)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "DELEGATED");
  const [request] = rec.requests();
  assert.equal(request.model, "ollama2/deepseek-v4.1-flash");
  assert.ok(request.model.startsWith("ollama2/"), "must not fall back to the exhausted ollama pool");
  assert.equal(outcome.model, request.model);
});

// ---------- E: all-low STOP ----------

await test("E: every candidate ineligible STOPs without emitting a request or spawning a child", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 3), snap("ollama2", 2), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "STOP");
  assert.match(outcome.reason, /quota-ineligible/);
  assert.equal(rec.emitCount(), 0, "a STOP must not emit a delegation request");
  assert.deepEqual(rec.requests(), []);
});

await test("E2: explicit model with an ineligible provider STOPs without emitting", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: { kind: "explicit", exactModel: "ollama/deepseek-v4.1-flash" },
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 2), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "STOP");
  assert.equal(outcome.affectedProvider, "ollama");
  assert.equal(rec.emitCount(), 0);
});

// ---------- F: parent isolation ----------

await test("F: an expensive parent model neither routes the worker nor changes the parent", async () => {
  const rec = recorder((req) => completed(req, req.model));
  // The parent's own model is authenticated and available, but it is not pool capacity.
  const available = [...ALL_AVAILABLE, PARENT_MODEL];
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80), snap("openai-codex", 80)),
    availableModels: available,
    spec: SPEC,
  });

  assert.equal(outcome.model, "ollama/deepseek-v4.1-flash");
  assert.notEqual(outcome.model, PARENT_MODEL);

  // The request cannot carry a parent-model change: it exposes no such field.
  const [request] = rec.requests();
  assert.equal(
    Object.keys(request).some((key) => /parent/i.test(key)),
    false,
    "the delegation request must expose no parent-model field",
  );
  assert.deepEqual(Object.keys(request).sort(), EXPECTED_REQUEST_KEYS);
  assert.equal(JSON.stringify(request).includes(PARENT_MODEL), false);
});

// ---------- model semantics: canonicalization vs a real substitution ----------

await test("canonical resolution (case/thinking suffix) is not reported as a mismatch", async () => {
  const rec = recorder((req) => completed(req, req.model.toUpperCase()));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: { ...SPEC, thinking: "medium" },
  });

  assert.equal(outcome.outcome, "DELEGATED");
  assert.equal(outcome.model, "ollama/deepseek-v4.1-flash");
  assert.equal(rec.requests()[0].thinking, "medium");
});

await test("a different model in the terminal response is exposed, never accepted silently", async () => {
  const rec = recorder((req) => completed(req, "ollama/glm-5.3-flash"));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
  });

  assert.equal(outcome.outcome, "MODEL_MISMATCH");
  assert.equal(outcome.selectedModel, "ollama/deepseek-v4.1-flash");
  assert.equal(outcome.actualModel, "ollama/glm-5.3-flash");
});

await test("no terminal response is reported, not treated as success", async () => {
  const rec = recorder(() => undefined);
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
    responseTimeoutMs: 20,
  });

  assert.equal(outcome.outcome, "NO_TERMINAL_RESPONSE");
  assert.equal(rec.requests().length, 1, "the request was still emitted");
});

await test("a response for a different identity is ignored", async () => {
  const rec = recorder((req) => ({
    ...completed(req, "xai/grok-4.6"),
    nodeId: "someone-elses-node",
  }));
  const outcome = await delegateSelectedSubagent(rec.transport, {
    mode: tier("medium"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
    spec: SPEC,
    responseTimeoutMs: 30,
  });

  assert.equal(outcome.outcome, "NO_TERMINAL_RESPONSE");
});

// ---------- buildDelegationRequest is pure ----------

await test("buildDelegationRequest pins the model and never mutates the spec", async () => {
  const spec = { ...SPEC };
  const before = JSON.stringify(spec);
  const request = buildDelegationRequest("xai/grok-4.6", spec);

  assert.equal(request.model, "xai/grok-4.6");
  assert.equal(JSON.stringify(spec), before);
  assert.equal(request.requestId, spec.requestId);
  assert.equal(request.ownerRunId, spec.ownerRunId);
  assert.equal(request.nodeId, spec.nodeId);
});

// ---------- mirrored public contract ----------

await test("mirrored delegation event names match the installed pi-subagents contract", async () => {
  // pi-subagents is not a dependency of this package, so it is resolved from the
  // installed extension tree when it is present; otherwise this check is skipped.
  const installedRoot = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
  const candidates = [
    "pi-subagents/delegation",
    pathToFileURL(join(installedRoot, "src", "api", "delegation.js")).href,
  ];
  let upstream;
  for (const spec of candidates) {
    try {
      upstream = await import(spec);
      break;
    } catch {
      /* try next */
    }
  }
  if (!upstream?.SUBAGENT_DELEGATION_REQUEST_EVENT) {
    console.log("SKIP mirrored event names: pi-subagents/delegation not importable here");
    return;
  }
  assert.equal(DELEGATION_REQUEST_EVENT, upstream.SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(DELEGATION_RESPONSE_EVENT, upstream.SUBAGENT_DELEGATION_RESPONSE_EVENT);
});

// ---------- selection is still core.ts's ----------

await test("the adapter's model equals core.ts's selection for the same inputs", async () => {
  const rec = recorder((req) => completed(req, req.model));
  const input = {
    mode: tier("big"),
    pool: POOL,
    quotaSnapshots: snapshots(snap("ollama", 80), snap("ollama2", 80), snap("xai", 80)),
    availableModels: ALL_AVAILABLE,
  };
  const selection = selectWorkerModel(input);
  const outcome = await delegateSelectedSubagent(rec.transport, { ...input, spec: SPEC });

  assert.equal(selection.outcome, "SELECTED");
  assert.equal(outcome.model, selection.model);
  assert.equal(rec.requests()[0].model, selection.model);
});

console.log(`${passed}/${passed} pi-worker-selector subagents adapter tests passed`);
