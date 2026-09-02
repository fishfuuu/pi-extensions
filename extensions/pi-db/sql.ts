export const MAX_ROWS = 200;
export const MAX_RESULT_BYTES = 32 * 1024;
export const QUERY_TIMEOUT_MS = 20_000;

const ALLOWED_START = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
const BLOCKED =
  /\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP|CREATE|RENAME|GRANT|REVOKE|LOAD_FILE|LOAD|CALL|LOCK|UNLOCK|COPY)\b/i;
const FILE_SINK = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;
const SELECT_INTO = /\bSELECT\s+.*\s+INTO\s+/i;

/**
 * Detect PostgreSQL writable CTE (data-modifying CTE with RETURNING).
 * Example: WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x;
 */
function hasWritableCTE(sql: string): boolean {
  // Look for WITH ... (mutation verb) ... pattern
  const ctePattern = /WITH\s+\w+\s+AS\s*\(\s*(INSERT|UPDATE|DELETE|MERGE)\b/i;
  return ctePattern.test(sql);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ");
}

/** Same text used for classify and execute. Reject MySQL versioned comments. */
export function normalizeSql(sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  if (/\/\*!\d*/.test(sql) || /\/\*!/.test(sql)) {
    return { ok: false, error: "refused: read-only (MySQL versioned comment)" };
  }
  const stripped = stripSqlComments(sql).replace(/\s+/g, " ").trim();
  if (!stripped) return { ok: false, error: "empty SQL" };
  const noTrail = stripped.replace(/;+\s*$/, "");
  if (noTrail.includes(";")) {
    return { ok: false, error: "refused: read-only (multiple statements)" };
  }
  return { ok: true, sql: noTrail };
}

export function classifySql(sql: string): { ok: true; kind: string; sql: string } | { ok: false; error: string } {
  const n = normalizeSql(sql);
  if (!n.ok) return n;
  const start = n.sql.match(ALLOWED_START);
  if (!start) {
    return { ok: false, error: "refused: read-only (only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH)" };
  }
  if (FILE_SINK.test(n.sql) || BLOCKED.test(n.sql)) {
    return { ok: false, error: "refused: read-only" };
  }
  if (SELECT_INTO.test(n.sql)) {
    return { ok: false, error: "refused: read-only (SELECT INTO)" };
  }
  if (hasWritableCTE(n.sql)) {
    return { ok: false, error: "refused: read-only (writable CTE)" };
  }
  return { ok: true, kind: start[1].toUpperCase(), sql: n.sql };
}

export function applyLimit(sql: string, kind: string): { sql: string; capped: boolean } {
  if (kind !== "SELECT" && kind !== "WITH") {
    return { sql, capped: false };
  }
  const commaLim = sql.match(/\bLIMIT\s+(\d+)\s*,\s*(\d+)\s*$/i);
  if (commaLim) {
    const count = Number(commaLim[2]);
    if (count > MAX_ROWS) {
      return {
        sql: sql.replace(/\bLIMIT\s+\d+\s*,\s*\d+\s*$/i, `LIMIT ${commaLim[1]}, ${MAX_ROWS}`),
        capped: true,
      };
    }
    return { sql, capped: false };
  }
  const lim = sql.match(/\bLIMIT\s+(\d+)(\s+OFFSET\s+\d+)?\s*$/i);
  if (lim) {
    const n = Number(lim[1]);
    if (n > MAX_ROWS) {
      return {
        sql: sql.replace(/\bLIMIT\s+\d+(?=\s+OFFSET\s+\d+\s*$|\s*$)/i, `LIMIT ${MAX_ROWS}`),
        capped: true,
      };
    }
    return { sql, capped: false };
  }
  return { sql: `${sql} LIMIT ${MAX_ROWS}`, capped: true };
}

export function prepareQuery(sql: string):
  | { ok: true; sql: string; kind: string; capped: boolean }
  | { ok: false; error: string } {
  const gate = classifySql(sql);
  if (!gate.ok) return gate;
  const limited = applyLimit(gate.sql, gate.kind);
  return { ok: true, sql: limited.sql, kind: gate.kind, capped: limited.capped };
}
