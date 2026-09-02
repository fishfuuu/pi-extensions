import { applyLimit, classifySql, prepareQuery } from "../sql.ts";

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("PASS", msg);
}

const deny = [
  ["SELECT * FROM t INTO OUTFILE '/tmp/x.csv'", "INTO OUTFILE"],
  ["SELECT LOAD_FILE('/etc/passwd')", "LOAD_FILE"],
  ["SELECT 1 /*! INTO OUTFILE '/tmp/pwn.txt' */", "versioned comment"],
  ["SELECT * FROM t INTO DUMPFILE '/tmp/x'", "INTO DUMPFILE"],
  ["DELETE FROM t", "DELETE"],
  ["SELECT 1; DELETE FROM t", "stacked"],
  ["INSERT INTO t VALUES (1)", "INSERT"],
  // PostgreSQL-specific dangerous constructs
  ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "writable CTE DELETE"],
  ["WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x", "writable CTE INSERT"],
  ["WITH x AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM x", "writable CTE UPDATE"],
  ["SELECT * INTO newtable FROM t", "SELECT INTO"],
  ["SELECT * INTO TEMP temptable FROM t", "SELECT INTO TEMP"],
  ["COPY t TO '/tmp/data.csv'", "COPY TO"],
  ["COPY t FROM '/tmp/data.csv'", "COPY FROM"],
];

const allow = [
  ["SELECT 1", "SELECT"],
  ["SHOW TABLES", "SHOW"],
  ["DESCRIBE cw_ys_budget", "DESCRIBE"],
  ['SELECT * FROM t WHERE note = "please skip"', "string not keyword"],
  // PostgreSQL-specific safe queries
  ["WITH readonly AS (SELECT * FROM t) SELECT * FROM readonly", "read-only CTE"],
  ["SELECT id, rules->>'type' AS rule_type FROM rules", "JSONB operator"],
  ["SELECT * FROM rules WHERE rules @> '{\"enabled\": true}'::jsonb", "JSONB containment"],
];

for (const [sql, name] of deny) {
  const r = classifySql(sql);
  check(!r.ok, `deny ${name}`);
}
for (const [sql, name] of allow) {
  const r = classifySql(sql);
  check(r.ok, `allow ${name}`);
}

const p = prepareQuery("SELECT * FROM t");
check(p.ok && p.sql.endsWith("LIMIT 200"), "prepare auto LIMIT");
const cap = prepareQuery("SELECT * FROM t LIMIT 5000");
check(cap.ok && /\bLIMIT 200\b/.test(cap.sql), "prepare cap LIMIT");
const comma = prepareQuery("SELECT * FROM t LIMIT 1000, 5000");
check(comma.ok && /LIMIT 1000, 200/.test(comma.sql), "prepare LIMIT offset,count cap");
const show = prepareQuery("SHOW TABLES");
check(show.ok && !show.sql.includes("LIMIT"), "SHOW no LIMIT");

const same = prepareQuery("SELECT 1 /* comment */");
check(same.ok && same.sql === "SELECT 1 LIMIT 200", "execute uses normalized SQL + LIMIT");

console.log("all sql tests passed");
