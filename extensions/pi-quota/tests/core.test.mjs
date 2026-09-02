import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  applyNav,
  compactWidgetLines,
  remainingOf,
  tightestQuota,
} from "../core.ts";

const discoverModule = process.env.PI_QUOTA_DISCOVER_MODULE
  ? pathToFileURL(process.env.PI_QUOTA_DISCOVER_MODULE).href
  : new URL("../discover.ts", import.meta.url).href;
const {
  discoverFromMeta,
  matchAdapter,
  originOf,
} = await import(discoverModule);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("matches only supported official provider origins", () => {
  assert.equal(matchAdapter("https://chatgpt.com"), "codex");
  assert.equal(matchAdapter("https://api.x.ai"), "xai");
  assert.equal(matchAdapter("https://ollama.com"), "ollama-cloud");
  assert.equal(matchAdapter("https://api.deepseek.com"), "deepseek-official");
  assert.equal(matchAdapter("https://proxy.example.com"), undefined);
});

test("normalizes origins and rejects invalid URLs", () => {
  assert.equal(originOf("https://api.deepseek.com/v1"), "https://api.deepseek.com");
  assert.equal(originOf("not a URL"), undefined);
});

test("discovery suppresses duplicate provider ids", () => {
  const targets = discoverFromMeta([
    { providerId: "codex", displayName: "Codex", origin: "https://chatgpt.com" },
    { providerId: "codex", displayName: "Duplicate", origin: "https://chatgpt.com" },
    { providerId: "proxy", displayName: "Proxy", origin: "https://proxy.example.com" },
  ]);
  assert.deepEqual(targets, [
    { providerId: "codex", displayName: "Codex", adapter: "codex" },
  ]);
});

test("remaining quota is clamped", () => {
  assert.equal(remainingOf(-5), 100);
  assert.equal(remainingOf(25), 75);
  assert.equal(remainingOf(150), 0);
});

test("tightest quota selects the least remaining window", () => {
  assert.deepEqual(
    tightestQuota({
      providerId: "codex",
      title: "Codex",
      rows: [
        { label: "5h", usedPct: 20 },
        { label: "7d", usedPct: 90, reset: "Sep 9" },
      ],
    }),
    { label: "7d", remainingPercent: 10, reset: "Sep 9" },
  );
});

test("navigation wraps and toggles expansion", () => {
  const start = { selectedIndex: 0, expanded: new Set() };
  const up = applyNav(start, "up", ["a", "b"]);
  assert.equal(up.selectedIndex, 1);
  const open = applyNav(up, "enter", ["a", "b"]);
  assert.equal(open.expanded.has("b"), true);
});

test("compact widget exposes status without secrets", () => {
  assert.deepEqual(
    compactWidgetLines([
      { providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 40 }] },
      { providerId: "xai", title: "xAI", error: "TIMEOUT", rows: [] },
    ]),
    ["Codex · 5h 60% left", "xAI · TIMEOUT"],
  );
});

console.log(`${passed}/${passed} pi-quota tests passed`);
