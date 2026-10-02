import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentToolHandler } from "../agent-tool.ts";

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

const POOL = [
  { model: "ollama/deepseek-v4.1-flash", capability: ["small", "medium"], costTier: "cheap" },
  { model: "xai/grok-4.6", capability: ["big"], costTier: "cheap" },
];

/** Stub the injected seams; default config is guard mode with no quota data. */
function handler({ routing = "guard", snapshots = new Map(), agentsDir = mkdtempSync(join(tmpdir(), "agents-")), failSnapshots = false } = {}) {
  const notifications = [];
  const h = createAgentToolHandler({
    loadConfig: () => ({
      pool: POOL,
      quotaPolicy: { thresholdPct: 10 },
      tiers: {},
      agentRouting: routing,
      agentTiers: {},
    }),
    loadSnapshots: async () => {
      if (failSnapshots) throw new Error("quota backend exploded");
      return snapshots;
    },
    availableModels: (poolModels) => poolModels,
    agentsDir,
  });
  return { h, notifications };
}

const agentEvent = (input) => ({ toolName: "Agent", input });

// ---------- policy mode ----------

test("policy mode writes the pool pick into event.input.model", async () => {
  const { h, notifications } = handler({ routing: "policy" });
  const event = agentEvent({ subagent_type: "general-purpose", prompt: "x" });
  await h(event, { ui: { notify: (m) => notifications.push(m) } });
  assert.equal(event.input.model, "ollama/deepseek-v4.1-flash");
  assert.equal(event.input.prompt, "x", "other arguments must be untouched");
  assert.match(notifications.join(" "), /general-purpose/);
});

// ---------- guard mode ----------

test("guard mode leaves a healthy pin alone and stays quiet", async () => {
  const { h, notifications } = handler({ snapshots: new Map([["zai-coding-cn", snap("zai-coding-cn", 70)]]) });
  const event = agentEvent({ subagent_type: "code-reviewer", model: "zai-coding-cn/glm-5.3" });
  await h(event, { ui: { notify: (m) => notifications.push(m) } });
  assert.equal(event.input.model, "zai-coding-cn/glm-5.3");
  assert.equal(notifications.length, 0);
});

test("guard mode swaps an ineligible provider's model", async () => {
  const { h, notifications } = handler({
    snapshots: new Map([
      ["zai-coding-cn", snap("zai-coding-cn", 3)],
      ["ollama", snap("ollama", 80)],
    ]),
  });
  const event = agentEvent({ subagent_type: "code-reviewer", model: "zai-coding-cn/glm-5.3" });
  await h(event, { ui: { notify: (m) => notifications.push(m) } });
  assert.equal(event.input.model, "ollama/deepseek-v4.1-flash");
  assert.match(notifications.join(" "), /zai-coding-cn/);
});

test("guard mode reads the profile pin from the agents directory", async () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(
    join(agentsDir, "code-reviewer.md"),
    ["---", "name: code-reviewer", "model: zai-coding-cn/glm-5.3", "---", "body"].join("\n"),
  );
  const { h } = handler({
    agentsDir,
    snapshots: new Map([
      ["zai-coding-cn", snap("zai-coding-cn", 2)],
      ["ollama", snap("ollama", 90)],
    ]),
  });
  const event = agentEvent({ subagent_type: "code-reviewer", prompt: "review this" });
  await h(event, {});
  assert.equal(event.input.model, "ollama/deepseek-v4.1-flash");
});

test("a profile with no pin inherits the parent in guard mode", async () => {
  const { h } = handler({ snapshots: new Map([["ollama", snap("ollama", 2)]]) });
  const event = agentEvent({ subagent_type: "general-purpose", prompt: "x" });
  await h(event, {});
  assert.equal(event.input.model, undefined);
});

// ---------- safety ----------

test("non-Agent tools are ignored", async () => {
  const { h } = handler({ routing: "policy" });
  const event = { toolName: "bash", input: { command: "echo hi" } };
  await h(event, {});
  assert.deepEqual(event.input, { command: "echo hi" });
});

test("a failing quota backend never breaks the call and never adds a model", async () => {
  const { h } = handler({ failSnapshots: true });
  const event = agentEvent({ subagent_type: "code-reviewer", model: "zai-coding-cn/glm-5.3" });
  await h(event, {});
  assert.equal(event.input.model, "zai-coding-cn/glm-5.3");
});

test("missing ui context does not throw on an intervention", async () => {
  const { h } = handler({
    routing: "policy",
  });
  const event = agentEvent({ subagent_type: "general-purpose" });
  await h(event, undefined);
  assert.equal(event.input.model, "ollama/deepseek-v4.1-flash");
});

test("unexpected input shapes are tolerated", async () => {
  const { h } = handler({ routing: "policy" });
  await h({ toolName: "Agent", input: undefined }, {});
  await h({ toolName: "Agent", input: null }, {});
  await h({ toolName: "Agent" }, {});
});

console.log(`${passed}/${passed} pi-worker-selector agent-tool wiring tests passed`);
