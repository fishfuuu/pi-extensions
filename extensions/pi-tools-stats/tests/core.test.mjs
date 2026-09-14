import assert from "node:assert/strict";
import {
  advice,
  aggregateRows,
  filterRows,
  formatStatsTable,
  mergeCatalog,
  parseStatsArgs,
  shortOwner,
  OBSERVE_MS,
} from "../core.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("shortOwner maps builtin and npm/extension paths", () => {
  assert.equal(shortOwner({ source: "builtin", path: "<builtin:read>" }), "builtin");
  assert.equal(shortOwner({ source: "sdk" }), "sdk");
  assert.equal(
    shortOwner({ path: "C:/Users/me/.pi/agent/extensions/pi-db/index.ts" }),
    "pi-db",
  );
  assert.equal(
    shortOwner({ path: "/home/me/.pi/agent/npm/node_modules/pi-subagents/index.ts" }),
    "pi-subagents",
  );
  assert.equal(
    shortOwner({
      path: "/home/me/.pi/agent/npm/node_modules/@estebanforge/pi-antigravity-bridge/index.ts",
    }),
    "@estebanforge/pi-antigravity-bridge",
  );
  assert.equal(shortOwner(undefined), "unknown");
});

test("advice distinguishes observe / unused-active / unused-inactive", () => {
  const now = 1_000_000_000_000;
  assert.equal(advice({ firstSeenMs: now - 1000, calls: 3, activeNow: true, nowMs: now }), "常用");
  assert.equal(
    advice({ firstSeenMs: now - 1000, calls: 0, activeNow: true, nowMs: now }),
    "观察中",
  );
  assert.equal(
    advice({ firstSeenMs: now - OBSERVE_MS - 1, calls: 0, activeNow: true, nowMs: now }),
    "从未用 · 可考虑卸",
  );
  assert.equal(
    advice({ firstSeenMs: now - OBSERVE_MS - 1, calls: 0, activeNow: false, nowMs: now }),
    "从未用 · 当前未启用",
  );
});

test("mergeCatalog keeps firstSeen and updates lastSeen/source", () => {
  const merged = mergeCatalog(
    {
      read: { name: "read", source: "builtin", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
    },
    [
      { name: "read", source: "builtin" },
      { name: "db_query", source: "pi-db" },
    ],
    "2026-01-08T00:00:00.000Z",
  );
  assert.equal(merged.read.firstSeen, "2026-01-01T00:00:00.000Z");
  assert.equal(merged.read.lastSeen, "2026-01-08T00:00:00.000Z");
  assert.equal(merged.db_query.source, "pi-db");
  assert.equal(merged.db_query.firstSeen, "2026-01-08T00:00:00.000Z");
});

test("hidden unused tools are not suggested for uninstall", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const rows = aggregateRows(
    {
      db_query: {
        name: "db_query",
        source: "pi-db",
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-02-01T00:00:00.000Z",
      },
    },
    [],
    new Set(),
    now,
    now - OBSERVE_MS,
  );
  assert.equal(rows[0].advice, "从未用 · 当前未启用");
  assert.equal(rows[0].activeNow, false);
});

test("filter and table helpers", () => {
  assert.equal(parseStatsArgs(""), "all");
  assert.equal(parseStatsArgs("unused"), "unused");
  assert.equal(parseStatsArgs("errors"), "errors");
  assert.equal(parseStatsArgs("nope"), "help");
  const rows = [
    {
      tool: "a",
      source: "builtin",
      calls: 0,
      failures: 0,
      firstSeen: "x",
      activeNow: true,
      advice: "观察中",
    },
    {
      tool: "b",
      source: "pi-db",
      calls: 2,
      failures: 1,
      lastTs: "2026-01-02T03:04:05.000Z",
      firstSeen: "x",
      activeNow: true,
      advice: "常用",
    },
  ];
  assert.equal(filterRows(rows, "unused").map((r) => r.tool).join(), "a");
  assert.equal(filterRows(rows, "errors").map((r) => r.tool).join(), "b");
  const table = formatStatsTable(filterRows(rows, "errors"));
  assert.match(table, /`b`/);
  assert.match(table, /pi-db/);
});

console.log(`${passed}/${passed} pi-tools-stats tests passed`);
