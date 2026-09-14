/** Pure helpers for pi-tools-stats. No Pi runtime, no disk. */

export const OBSERVE_MS = 7 * 24 * 60 * 60 * 1000;

export type SourceInfoLike = {
  source?: string;
  path?: string;
};

export type CatalogEntry = {
  name: string;
  source: string;
  firstSeen: string;
  lastSeen: string;
};

export type ToolEvent = {
  tool: string;
  source: string;
  ok: boolean;
  durationMs: number;
  ts: string;
};

export type StatsRow = {
  tool: string;
  source: string;
  calls: number;
  failures: number;
  lastTs?: string;
  firstSeen: string;
  activeNow: boolean;
  advice: string;
};

export function shortOwner(info: SourceInfoLike | undefined): string {
  if (!info) return "unknown";
  const source = (info.source ?? "").toLowerCase();
  const path = (info.path ?? "").replace(/\\/g, "/");
  if (source === "builtin" || path.startsWith("<builtin:")) return "builtin";
  if (source === "sdk") return "sdk";

  const nm = path.split("/node_modules/");
  if (nm.length > 1) {
    const rest = nm[nm.length - 1].split("/").filter(Boolean);
    if (rest[0]?.startsWith("@") && rest[1]) return `${rest[0]}/${rest[1]}`;
    if (rest[0]) return rest[0];
  }

  const ext = path.split("/extensions/");
  if (ext.length > 1) {
    const name = ext[ext.length - 1].split("/").filter(Boolean)[0];
    if (name) return name;
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  if (source) return info.source as string;
  return "unknown";
}

export function advice(row: {
  firstSeenMs: number;
  calls: number;
  activeNow: boolean;
  nowMs: number;
  observeMs?: number;
}): string {
  if (row.calls > 0) return "常用";
  const window = row.observeMs ?? OBSERVE_MS;
  if (row.nowMs - row.firstSeenMs < window) return "观察中";
  if (row.activeNow) return "从未用 · 可考虑卸";
  return "从未用 · 当前未启用";
}

export function mergeCatalog(
  existing: Record<string, CatalogEntry>,
  snapshot: Array<{ name: string; source: string }>,
  nowIso: string,
): Record<string, CatalogEntry> {
  const next: Record<string, CatalogEntry> = { ...existing };
  for (const tool of snapshot) {
    if (!tool.name) continue;
    const prev = next[tool.name];
    if (!prev) {
      next[tool.name] = {
        name: tool.name,
        source: tool.source || "unknown",
        firstSeen: nowIso,
        lastSeen: nowIso,
      };
      continue;
    }
    next[tool.name] = {
      ...prev,
      source: tool.source || prev.source,
      lastSeen: nowIso,
    };
  }
  return next;
}

export function aggregateRows(
  catalog: Record<string, CatalogEntry>,
  events: ToolEvent[],
  active: Set<string>,
  nowMs: number,
  sinceMs: number,
): StatsRow[] {
  const counts = new Map<string, { calls: number; failures: number; lastTs?: string }>();
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const cur = counts.get(ev.tool) ?? { calls: 0, failures: 0 };
    cur.calls += 1;
    if (!ev.ok) cur.failures += 1;
    if (!cur.lastTs || ev.ts > cur.lastTs) cur.lastTs = ev.ts;
    counts.set(ev.tool, cur);
  }

  const rows: StatsRow[] = [];
  for (const entry of Object.values(catalog)) {
    const c = counts.get(entry.name) ?? { calls: 0, failures: 0 };
    const firstSeenMs = Date.parse(entry.firstSeen);
    rows.push({
      tool: entry.name,
      source: entry.source,
      calls: c.calls,
      failures: c.failures,
      lastTs: c.lastTs,
      firstSeen: entry.firstSeen,
      activeNow: active.has(entry.name),
      advice: advice({
        firstSeenMs: Number.isFinite(firstSeenMs) ? firstSeenMs : nowMs,
        calls: c.calls,
        activeNow: active.has(entry.name),
        nowMs,
      }),
    });
  }
  rows.sort((a, b) => {
    if (b.failures !== a.failures) return b.failures - a.failures;
    if (b.calls !== a.calls) return b.calls - a.calls;
    return a.tool.localeCompare(b.tool);
  });
  return rows;
}

export function filterRows(rows: StatsRow[], mode: "all" | "unused" | "errors"): StatsRow[] {
  if (mode === "unused") return rows.filter((r) => r.calls === 0);
  if (mode === "errors") return rows.filter((r) => r.failures > 0);
  return rows;
}

export function parseStatsArgs(args: string): "all" | "unused" | "errors" | "help" {
  const a = args.trim().toLowerCase();
  if (!a || a === "all") return "all";
  if (a === "unused") return "unused";
  if (a === "errors") return "errors";
  return "help";
}

export function formatStatsTable(rows: StatsRow[]): string {
  if (rows.length === 0) return "No matching tools.";
  const header = "| 工具 | 来源 | 7天调用 | 失败 | 上次 | 建议 |";
  const sep = "|---|---|---:|---:|---|---|";
  const body = rows.map((r) => {
    const last = r.lastTs ? r.lastTs.slice(0, 16).replace("T", " ") : "—";
    return `| \`${r.tool}\` | ${r.source} | ${r.calls} | ${r.failures} | ${last} | ${r.advice} |`;
  });
  return [header, sep, ...body].join("\n");
}
