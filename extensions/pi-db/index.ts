/**
 * pi-db — read-only MySQL query tool for the agent.
 *
 * Agent writes SQL; the table comes back as the tool result (visible to
 * both the model and the user). No writes. No localhost fallback.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import mysql from "mysql2/promise";
import pg from "pg";
import {
  assertProjectEnabled,
  canonicalPath,
  DEFAULT_TARGET_LABEL,
  getProjectRoot,
  resolveTarget,
} from "./project-gate.ts";
import {
  MAX_RESULT_BYTES,
  MAX_ROWS,
  prepareQuery,
  QUERY_TIMEOUT_MS,
} from "./sql.ts";
import { loadDbConfig, type DbConfig } from "./env.ts";

const CELL_MAX = 120;
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Cached result. The cache holds ONE latest result per project, tagged with the
 * target it came from — it is not a per-project-per-target cache. `/db --last`
 * displays the tag so a result is never misattributed to another environment.
 */
type LastResult = { scope: string; target: string; at: number; text: string };

let lastResult: LastResult | undefined;

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

async function executeMysql(
  cfg: DbConfig,
  sql: string,
  signal?: AbortSignal
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
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
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
    });
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    const [raw] = await conn.query({ sql, timeout: QUERY_TIMEOUT_MS });
    const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    return { ok: true, rows };
  } catch (e: unknown) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    return { ok: false, error: mysqlFailCode(e) };
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

async function executePostgres(
  cfg: DbConfig,
  sql: string,
  signal?: AbortSignal
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  const onAbort = () => {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    // PostgreSQL read-only transaction with statement timeout
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const result = await client.query(sql);
    await client.query("ROLLBACK"); // Always rollback read-only transaction
    return { ok: true, rows: result.rows as Record<string, unknown>[] };
  } catch (e: unknown) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    // Sanitize PostgreSQL errors (remove connection details)
    const msg = e instanceof Error ? e.message : String(e);
    const sanitized = msg
      .replace(/password[^\s]*/gi, "***")
      .replace(/host[=:]\S+/gi, "host=***")
      .replace(/Connection string[^\n]*/gi, "Connection string: ***");
    return { ok: false, error: `PostgreSQL error: ${sanitized}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

async function runQuery(ctx: ExtensionContext, sql: string, target?: string, signal?: AbortSignal) {
  const projectCheck = assertProjectEnabled(ctx.cwd);
  if (!projectCheck.ok) return fail(projectCheck.error);
  if (!ctx.isProjectTrusted()) {
    return fail("project is not trusted; db_query skipped");
  }
  if (signal?.aborted) return fail("aborted");
  const prepared = prepareQuery(sql);
  if (!prepared.ok) return fail(prepared.error);

  // Fail-closed: a project that defines named targets refuses a query that names
  // none, so the environment is never guessed.
  const resolved = resolveTarget(projectCheck.config, target);
  if (!resolved.ok) return fail(resolved.error);

  const loaded = loadDbConfig(
    projectCheck.projectRoot,
    resolved.target.envFile,
    resolved.target.envPrefix,
    // Only a legacy single-target config keeps the ambient-environment fallback.
    // For a named target, the selected env file is the whole boundary.
    resolved.label === DEFAULT_TARGET_LABEL
  );
  if (!loaded.ok) return fail(loaded.error);

  const dialect = resolved.target.dialect;
  const result =
    dialect === "postgres"
      ? await executePostgres(loaded.cfg, prepared.sql, signal)
      : await executeMysql(loaded.cfg, prepared.sql, signal);

  if (!result.ok) return fail(result.error);

  const rows = result.rows;
  const shown = rows.slice(0, MAX_ROWS);
  const table = toMarkdown(shown);
  const notes: string[] = [`${shown.length} row(s)`];
  if (prepared.capped) notes.push(`LIMIT ${MAX_ROWS} applied`);
  if (rows.length > MAX_ROWS) notes.push("truncated");
  const text = capText(`${notes.join(" · ")}\n\n${table}`);
  lastResult = {
    scope: canonicalPath(projectCheck.projectRoot),
    target: resolved.label,
    at: Date.now(),
    text,
  };
  return { content: [{ type: "text" as const, text }] };
}

const dbQueryTool = defineTool({
  name: "db_query",
  label: "DB Query",
  description:
    "Run a read-only database query (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) against the project database. Supports MySQL/MariaDB and PostgreSQL. Use to verify counts, sums, and VIEW output. Writes are refused. Results come back as a markdown table. When the project config defines named targets, pass `target`; a query without one is refused.",
  promptSnippet: "Read-only MySQL/PostgreSQL: verify counts/sums/VIEW rows (SELECT/SHOW/DESCRIBE only)",
  promptGuidelines: [
    "Use db_query for read-only data checks on MySQL or PostgreSQL (counts, sums, DISTINCT, VIEW samples).",
    "Never ask db_query to INSERT/UPDATE/DELETE. Prefer COUNT/SUM/GROUP BY over SELECT *.",
    "Do not invent host/password; the tool reads credentials from the project's configured .env file.",
    "Pass `target` when the project's .pi/pi-db.json defines named targets (e.g. environments). A query without one is refused, so never guess which environment to query.",
  ],
  parameters: Type.Object({
    sql: Type.String({ description: "Read-only SQL (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH)" }),
    target: Type.Optional(
      Type.String({
        description:
          "Named target from .pi/pi-db.json (e.g. an environment). Required when that project defines targets; omit otherwise.",
      })
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    return runQuery(ctx, params.sql, params.target, signal);
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
        // Always name the environment the result came from, so a stored result is
        // never mistaken for a different target.
        const where = lastResult.target === DEFAULT_TARGET_LABEL ? "" : ` [${lastResult.target}]`;
        const title = `[pi-db] last result${where} (${age}s ago)`;
        ctx.ui.notify(title, "info");
        if (ctx.hasUI) {
          await ctx.ui.editor(title, lastResult.text);
        }
        return;
      }
      ctx.ui.notify("[pi-db] queries are an agent tool (db_query). Ask the agent, or /db --last.", "info");
    },
  });
}
