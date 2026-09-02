import assert from "node:assert/strict";
import {
  CORE_TOOLS,
  applyCapability,
  applyCorePreset,
  toolsForCapability,
} from "../core.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("core preset keeps editing, planning, navigation, and the loader", () => {
  for (const name of ["read", "bash", "powershell", "edit", "write", "todo", "symbol_search", "pi_tool_presets"]) {
    assert.equal(CORE_TOOLS.has(name), true, `missing core tool ${name}`);
  }
});

test("core preset removes managed specialist tools", () => {
  const active = ["read", "web_search", "mcp", "subagent", "workflow", "db_query", "unknown_tool"];
  const next = applyCorePreset(active);
  assert.deepEqual(next.sort(), ["pi_tool_presets", "read", "symbol_search", "todo", "unknown_tool"].sort());
});

test("core preset preserves unknown third-party tools", () => {
  assert.equal(applyCorePreset(["read", "clawd_custom_tool"]).includes("clawd_custom_tool"), true);
});

test("capability groups are additive", () => {
  const next = applyCapability(["read", "pi_tool_presets"], "research");
  assert.equal(next.includes("read"), true);
  for (const name of toolsForCapability("research")) assert.equal(next.includes(name), true);
});

test("orchestration capability includes both supported control planes", () => {
  const tools = toolsForCapability("orchestration");
  for (const name of ["subagent", "bg_wait", "workflow", "workflow_control"]) {
    assert.equal(tools.includes(name), true, `missing orchestration tool ${name}`);
  }
});

test("all capability restores every registered tool supplied by the runtime", () => {
  const all = ["read", "web_search", "mcp", "subagent", "workflow", "db_query"];
  assert.deepEqual(applyCapability(["read"], "all", all), all);
});

console.log(`${passed}/${passed} pi-tool-presets tests passed`);
