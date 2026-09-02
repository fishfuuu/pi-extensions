/**
 * pi-db — read-only MySQL query tool for the agent.
 *
 * Agent writes SQL; the table comes back as the tool result (visible to
 * both the model and the user). No writes. No localhost fallback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import mysql from "mysql2/promise";
import { assertProjectEnabled, canonicalPath, getProjectRoot } from "./project-gate.ts";
import {
  MAX_RESULT_BYTES,
  MAX_ROWS,
  prepareQuery,
  QUERY_TIMEOUT_MS,
} from "./sql.ts";

const CELL_MAX = 120;
const CONNECT_TIMEOUT_MS = 8_000;

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

type LastResult = { scope: string; at: number; text: string };

let lastResult: LastResult | undefined;

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    let key = s.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function findEnvFile(projectRoot: string, envFile: string): string | undefined {
  const envPath = path.join(projectRoot, envFile);
  return fs.existsSync(envPath) ? envPath : undefined;
}

function loadDbConfig(
  projectRoot: string,
  envFile: string,
  envPrefix: string
): { ok: true; cfg: DbConfig } | { ok: false; error: string } {
  const envPath = findEnvFile(projectRoot, envFile);
  if (!envPath) {
    return { ok: false, error: `no .env found at ${envFile}; refuse localhost` };
  }
  const env = parseEnvFile(envPath);
  const host = (env[`${envPrefix}HOST`] || process.env[`${envPrefix}HOST`] || "").trim();
  const database = (env[`${envPrefix}NAME`] || process.env[`${envPrefix}NAME`] || "").trim();
  const user = (env[`${envPrefix}USER`] || process.env[`${envPrefix}USER`] || "").trim();
  const password = env[`${envPrefix}PASSWORD`] || process.env[`${envPrefix}PASSWORD`] || "";
  const portRaw = env[`${envPrefix}PORT`] || process.env[`${envPrefix}PORT`] || "3306";
  const port = Number(portRaw);
  if (!host || !database) {
    return { ok: false, error: `${envPrefix}HOST or ${envPrefix}NAME missing in .env; refuse localhost` };
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return { ok: false, error: `${envPrefix}HOST is localhost; refuse (MySQL is remote, dotenv was not applied)` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `${envPrefix}PORT is invalid` };
  }
  if (!user) {
    return { ok: false, error: `${envPrefix}USER missing` };
  }
  return { ok: true, cfg: { host, port, user, password, database } };
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return `<blob ${v.length}b>`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.length <= CELL_MAX) return s;
  return `${s.slice(0, CELL_MAX)}…`;
}

function toMarkdown(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(0 rows)";
  const cols = Object.keys(rows[0]);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function mysqlFailCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return `query failed (${(e as { code: string }).code})`;
  }
  return "query failed";
}

function capText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text;
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > MAX_RESULT_BYTES && cut.length > 0) {
    cut = cut.slice(0, Math.max(0, cut.length - 256));
  }
  return `${cut.trimEnd()}\n\n[truncated: result exceeded ${MAX_RESULT_BYTES} bytes]`;
}

async function runQuery(ctx: ExtensionContext, sql: string, signal?: AbortSignal) {
  const projectCheck = assertProjectEnabled(ctx.cwd);
  if (!projectCheck.ok) return fail(projectCheck.error);
  if (!ctx.isProjectTrusted()) {
    return fail("project is not trusted; db_query skipped");
  }
  if (signal?.aborted) return fail("aborted");
  const prepared = prepareQuery(sql);
  if (!prepared.ok) return fail(prepared.error);
  const loaded = loadDbConfig(
    projectCheck.projectRoot,
    projectCheck.config.envFile,
    projectCheck.config.envPrefix
  );
  if (!loaded.ok) return fail(loaded.error);
  let conn: mysql.Connection | undefined;
  const onAbort = () => {
    if (conn) {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    conn = await mysql.createConnection({
      host: loaded.cfg.host,
      port: loaded.cfg.port,
      user: loaded.cfg.user,
      password: loaded.cfg.password,
      database: loaded.cfg.database,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
    });
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    const [raw] = await conn.query({ sql: prepared.sql, timeout: QUERY_TIMEOUT_MS });
    const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    const shown = rows.slice(0, MAX_ROWS);
    const table = toMarkdown(shown);
    const notes: string[] = [`${shown.length} row(s)`];
    if (prepared.capped) notes.push(`LIMIT ${MAX_ROWS} applied`);
    if (rows.length > MAX_ROWS) notes.push("truncated");
    const text = capText(`${notes.join(" · ")}\n\n${table}`);
    lastResult = { scope: canonicalPath(projectCheck.projectRoot), at: Date.now(), text };
    return { content: [{ type: "text" as const, text }] };
  } catch (e: unknown) {
    if (signal?.aborted) return fail("aborted");
    return fail(mysqlFailCode(e));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (conn) {
      try {
        await conn.end();
      } catch {
        /* ignore */
      }
    }
  }
}

const dbQueryTool = defineTool({
  name: "db_query",
  label: "DB Query",
  description:
    "Run a read-only MySQL query (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) against the project database. Use to verify counts, sums, and VIEW output. Writes are refused. Results come back as a markdown table.",
  promptSnippet: "Read-only MySQL: verify counts/sums/VIEW rows (SELECT/SHOW/DESCRIBE only)",
  promptGuidelines: [
    "Use db_query for read-only data checks on MySQL (counts, sums, DISTINCT, VIEW samples).",
    "Never ask db_query to INSERT/UPDATE/DELETE. Prefer COUNT/SUM/GROUP BY over SELECT *.",
    "Do not invent host/password; the tool reads credentials from the project's configured .env file.",
  ],
  parameters: Type.Object({
    sql: Type.String({ description: "Read-only SQL (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH)" }),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    return runQuery(ctx, params.sql, signal);
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(dbQueryTool);
  pi.registerCommand("db", {
    description: "Show last db_query result (agent tool). Use --last; the agent runs queries via db_query.",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw === "--last" || raw === "") {
        const projectCheck = assertProjectEnabled(ctx.cwd);
        if (!projectCheck.ok) {
          ctx.ui.notify(projectCheck.error, "error");
          return;
        }
        const scope = canonicalPath(projectCheck.projectRoot);
        if (!lastResult || lastResult.scope !== scope) {
          ctx.ui.notify("[pi-db] no previous db_query in this session", "info");
          return;
        }
        const age = Math.round((Date.now() - lastResult.at) / 1000);
        ctx.ui.notify(`[pi-db] last result (${age}s ago)`, "info");
        if (ctx.hasUI) {
          await ctx.ui.editor(`[pi-db] last result (${age}s ago)`, lastResult.text);
        }
        return;
      }
      ctx.ui.notify("[pi-db] queries are an agent tool (db_query). Ask the agent, or /db --last.", "info");
    },
  });
}
