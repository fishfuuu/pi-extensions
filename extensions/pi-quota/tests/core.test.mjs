import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  applyNav,
  compactWidgetLines,
  configuredQuotaCards,
  isQuotaPanelCloseInput,
  ollamaBalanceView,
  ollamaUsageLine,
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
  assert.equal(matchAdapter("https://open.bigmodel.cn"), "zhipu-cn-coding");
  assert.equal(matchAdapter("https://api.z.ai"), "zhipu-intl-coding");
  assert.equal(matchAdapter("https://proxy.example.com"), undefined);
});

test("normalizes origins and rejects invalid URLs", () => {
  assert.equal(originOf("https://api.deepseek.com/v1"), "https://api.deepseek.com");
  assert.equal(originOf("https://open.bigmodel.cn/api/coding/paas/v4"), "https://open.bigmodel.cn");
  assert.equal(originOf("https://api.z.ai/api/coding/paas/v4"), "https://api.z.ai");
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

test("hides providers with no credential from the panel", () => {
  const visible = configuredQuotaCards([
    { providerId: "deepseek", title: "DeepSeek", error: "MISSING_CREDENTIAL", rows: [] },
    { providerId: "codex", title: "Codex", rows: [{ label: "5h", usedPct: 10 }] },
    { providerId: "xai", title: "xAI", error: "AUTH_INVALID", rows: [] },
  ]);
  assert.deepEqual(
    visible.map((c) => c.providerId),
    ["codex", "xai"],
  );
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

test("quota panel closes on Escape, Ctrl+C (Pi Web Close), and q/Q", () => {
  assert.equal(isQuotaPanelCloseInput("\x1b"), true);
  assert.equal(isQuotaPanelCloseInput("\x03"), true);
  assert.equal(isQuotaPanelCloseInput("q"), true);
  assert.equal(isQuotaPanelCloseInput("Q"), true);
  assert.equal(isQuotaPanelCloseInput("m"), false);
  assert.equal(isQuotaPanelCloseInput("\r"), false);
});

test("ollama balance: legacy session/weekly plan maps remaining_percent", () => {
  const view = ollamaBalanceView({
    included: {
      session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
      weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
    },
    purchased: { balance_usd: 25 },
  });
  assert.deepEqual(view, {
    rows: [
      { label: "5h", usedPct: 25, resetIso: "2026-10-01T07:00:00Z" },
      { label: "Weekly", usedPct: 60, resetIso: "2026-10-05T00:00:00Z" },
    ],
    extras: ["Purchased $25.00"],
  });
});

test("ollama balance: credit plan maps balance over allowance", () => {
  const view = ollamaBalanceView({
    included: {
      balance_usd: 72.5,
      allowance_usd: 100,
      period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
    },
    purchased: { balance_usd: 25 },
  });
  assert.deepEqual(view, {
    rows: [{ label: "Monthly", usedPct: 27.5, resetIso: "2026-10-15T09:30:00Z" }],
    extras: ["Purchased $25.00"],
  });
});

test("ollama balance: credit plan without allowance stays explicit", () => {
  const view = ollamaBalanceView({ included: { balance_usd: 3 }, purchased: { balance_usd: 0 } });
  assert.deepEqual(view, { rows: [], extras: ["Included $3.00"] });
});

test("ollama balance: /api/usage payload is never read as a balance", () => {
  const cloudUsage = {
    range: "7d",
    scope: "self",
    granularity: "day",
    totals: { request_count: 1613, usage_usd: 0.42 },
    buckets: [{ from: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", request_count: 3 }],
  };
  assert.equal(ollamaBalanceView(cloudUsage), undefined);
  assert.equal(ollamaBalanceView({}), undefined);
  assert.equal(ollamaBalanceView({ included: {} }), undefined);
  assert.equal(ollamaBalanceView(null), undefined);
});

test("ollama balance: out-of-range remaining_percent is ignored, not clamped", () => {
  assert.equal(ollamaBalanceView({ included: { session: { remaining_percent: 150 } } }), undefined);
  assert.equal(ollamaBalanceView({ included: { weekly: { remaining_percent: -1 } } }), undefined);
});

test("ollama usage line: request counts with and without cost", () => {
  assert.equal(ollamaUsageLine({ totals: { request_count: 15, usage_usd: 0.01718 } }, "24h"), "24h 15 req \u00b7 $0.0172");
  assert.equal(ollamaUsageLine({ totals: { request_count: 1613, usage_usd: 12.5 } }, "7d"), "7d 1613 req \u00b7 $12.50");
  assert.equal(ollamaUsageLine({ totals: { request_count: 8 } }, "7d"), "7d 8 req");
  assert.equal(ollamaUsageLine({ range: "7d" }, "7d"), undefined);
  assert.equal(ollamaUsageLine(null, "24h"), undefined);
});
console.log(`${passed}/${passed} pi-quota tests passed`);
