/**
 * pi-tools-stats — read-only tool usage / health.
 * Catalog on session_start. Events only on tool_result. Never setActiveTools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  OBSERVE_MS,
  aggregateRows,
  filterRows,
  formatStatsTable,
  mergeCatalog,
  parseStatsArgs,
  shortOwner,
  type CatalogEntry,
  type ToolEvent,
} from "./core.ts";

const STATS_DIR = path.join(os.homedir(), ".pi", "agent", "tools-stats");
const CATALOG_PATH = path.join(STATS_DIR, "catalog.json");
const EVENTS_PATH = path.join(STATS_DIR, "events.jsonl");

type Pending = { tool: string; t0: number };

function failOpen(fn: () => void): void {
  try {
    fn();
  } catch {
    /* stats must never break tools */
  }
}

function readCatalog(): Record<string, CatalogEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, CatalogEntry>;
  } catch {
    return {};
  }
}

function writeCatalog(catalog: Record<string, CatalogEntry>): void {
  fs.mkdirSync(STATS_DIR, { recursive: true });
  const tmp = `${CATALOG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.renameSync(tmp, CATALOG_PATH);
}

function appendEvent(event: ToolEvent): void {
  fs.mkdirSync(STATS_DIR, { recursive: true });
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`);
}

function readEvents(): ToolEvent[] {
  try {
    const text = fs.readFileSync(EVENTS_PATH, "utf8");
    const out: ToolEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as ToolEvent;
        if (row && typeof row.tool === "string") out.push(row);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function snapshotTools(pi: ExtensionAPI): Array<{ name: string; source: string }> {
  return pi.getAllTools().map((t) => ({
    name: t.name,
    source: shortOwner(t.sourceInfo),
  }));
}

export default function (pi: ExtensionAPI): void {
  const pending = new Map<string, Pending>();
  const sources = new Map<string, string>();

  function refreshCatalog(): Record<string, CatalogEntry> {
    const snap = snapshotTools(pi);
    for (const t of snap) sources.set(t.name, t.source);
    const nowIso = new Date().toISOString();
    const catalog = mergeCatalog(readCatalog(), snap, nowIso);
    writeCatalog(catalog);
    return catalog;
  }

  pi.on("session_start", () => {
    failOpen(() => {
      refreshCatalog();
    });
  });

  pi.on("tool_call", (event) => {
    failOpen(() => {
      const id = String(event.toolCallId ?? "");
      const name = String(event.toolName ?? "");
      if (!id || !name) return;
      pending.set(id, { tool: name, t0: Date.now() });
    });
  });

  pi.on("tool_result", (event) => {
    failOpen(() => {
      const id = String(event.toolCallId ?? "");
      const name = String(event.toolName ?? "");
      const start = pending.get(id);
      if (id) pending.delete(id);
      const tool = start?.tool || name;
      if (!tool) return;
      const source = sources.get(tool) || "unknown";
      const rec = event as { isError?: boolean };
      appendEvent({
        tool,
        source,
        ok: rec.isError !== true,
        durationMs: start ? Math.max(0, Date.now() - start.t0) : 0,
        ts: new Date().toISOString(),
      });
    });
  });

  pi.registerCommand("tools-stats", {
    description: "Show tool usage for the last 7 days (unused | errors). Read-only.",
    handler: (args: string, ctx: ExtensionCommandContext) => {
      const mode = parseStatsArgs(args);
      if (mode === "help") {
        ctx.ui.notify("Usage: /tools-stats [unused|errors]", "info");
        return;
      }
      let catalog: Record<string, CatalogEntry> = {};
      try {
        catalog = refreshCatalog();
      } catch {
        catalog = readCatalog();
      }
      const now = Date.now();
      const rows = filterRows(
        aggregateRows(
          catalog,
          readEvents(),
          new Set(pi.getActiveTools()),
          now,
          now - OBSERVE_MS,
        ),
        mode,
      );
      const table = formatStatsTable(rows);
      const heading =
        mode === "unused" ? "Unused tools (7d)" : mode === "errors" ? "Tools with failures (7d)" : "Tool stats (7d)";
      ctx.ui.notify(`${heading}\n${table}`, "info");
    },
  });
}
