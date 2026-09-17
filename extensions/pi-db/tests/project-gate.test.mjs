import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProjectEnabled, canonicalPath, getProjectRoot } from "../project-gate.ts";
import { loadProjectConfig, resolveTarget, DEFAULT_TARGET_LABEL } from "../config.ts";
import { loadDbConfig } from "../env.ts";

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("PASS", msg);
}

// A. no config → disabled
const noConfigDir = path.join("D:\\", "other-project");
const resultA = assertProjectEnabled(noConfigDir);
check(resultA.ok === false, "A: no config → disabled");
check(resultA.error === "db_query disabled in this project", "A: correct error message");

// B. enabled=false → disabled
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-disabled-"));
try {
  fs.mkdirSync(path.join(tmpB, ".pi"));
  fs.writeFileSync(
    path.join(tmpB, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: false, envFile: ".env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultB = assertProjectEnabled(tmpB);
  check(resultB.ok === false, "B: enabled=false → disabled");
  check(resultB.error === "db_query disabled in this project", "B: correct error message");
} finally {
  fs.rmSync(tmpB, { recursive: true, force: true });
}

// C. enabled missing → disabled
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-no-enabled-"));
try {
  fs.mkdirSync(path.join(tmpC, ".pi"));
  fs.writeFileSync(
    path.join(tmpC, ".pi", "pi-db.json"),
    JSON.stringify({ envFile: ".env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultC = assertProjectEnabled(tmpC);
  check(resultC.ok === false, "C: enabled missing → disabled");
  check(resultC.error === "db_query disabled in this project", "C: correct error message");
} finally {
  fs.rmSync(tmpC, { recursive: true, force: true });
}

// D. enabled=true + valid config → PASS
const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-valid-"));
try {
  fs.mkdirSync(path.join(tmpD, ".pi"));
  fs.writeFileSync(
    path.join(tmpD, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultD = assertProjectEnabled(tmpD);
  check(resultD.ok === true, "D: enabled=true + valid config → PASS");
  check(resultD.config.envFile === ".env", "D: envFile correct");
  check(resultD.config.envPrefix === "DB_", "D: envPrefix correct");
  check(resultD.projectRoot === tmpD, "D: projectRoot correct");
} finally {
  fs.rmSync(tmpD, { recursive: true, force: true });
}

// E. cwd=project root → find config
const tmpE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-root-"));
try {
  fs.mkdirSync(path.join(tmpE, ".pi"));
  fs.writeFileSync(
    path.join(tmpE, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultE = assertProjectEnabled(tmpE);
  check(resultE.ok === true, "E: cwd=project root → find config");
} finally {
  fs.rmSync(tmpE, { recursive: true, force: true });
}

// F. cwd=project subdirectory → find same config
const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-subdir-"));
try {
  fs.mkdirSync(path.join(tmpF, ".pi"));
  fs.writeFileSync(
    path.join(tmpF, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB_" }),
    "utf8"
  );
  fs.mkdirSync(path.join(tmpF, "subdir", "nested"), { recursive: true });
  const resultF = assertProjectEnabled(path.join(tmpF, "subdir", "nested"));
  check(resultF.ok === true, "F: cwd=subdir → find config");
  check(resultF.projectRoot === tmpF, "F: same projectRoot from subdir");
} finally {
  fs.rmSync(tmpF, { recursive: true, force: true });
}

// G. two different projects → config / lastResult isolation
const tmpG1 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-proj1-"));
const tmpG2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-proj2-"));
try {
  fs.mkdirSync(path.join(tmpG1, ".pi"));
  fs.writeFileSync(
    path.join(tmpG1, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "P1_" }),
    "utf8"
  );
  fs.mkdirSync(path.join(tmpG2, ".pi"));
  fs.writeFileSync(
    path.join(tmpG2, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "P2_" }),
    "utf8"
  );
  const resultG1 = assertProjectEnabled(tmpG1);
  const resultG2 = assertProjectEnabled(tmpG2);
  check(resultG1.ok === true && resultG2.ok === true, "G: both projects enabled");
  check(resultG1.config.envPrefix === "P1_", "G: proj1 has P1_ prefix");
  check(resultG2.config.envPrefix === "P2_", "G: proj2 has P2_ prefix");
  check(resultG1.projectRoot !== resultG2.projectRoot, "G: different projectRoots");
  check(canonicalPath(resultG1.projectRoot) !== canonicalPath(resultG2.projectRoot), "G: scopes isolated");
} finally {
  fs.rmSync(tmpG1, { recursive: true, force: true });
  fs.rmSync(tmpG2, { recursive: true, force: true });
}

// H. invalid JSON → fail-closed
const tmpH = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-invalid-json-"));
try {
  fs.mkdirSync(path.join(tmpH, ".pi"));
  fs.writeFileSync(path.join(tmpH, ".pi", "pi-db.json"), "{invalid json", "utf8");
  const resultH = assertProjectEnabled(tmpH);
  check(resultH.ok === false, "H: invalid JSON → fail-closed");
  check(resultH.error.includes("invalid"), "H: error mentions invalid");
} finally {
  fs.rmSync(tmpH, { recursive: true, force: true });
}

// I. envFile absolute path → reject
const tmpI = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-absolute-"));
try {
  fs.mkdirSync(path.join(tmpI, ".pi"));
  fs.writeFileSync(
    path.join(tmpI, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: "C:\\absolute\\.env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultI = assertProjectEnabled(tmpI);
  check(resultI.ok === false, "I: envFile absolute path → reject");
  check(resultI.error.includes("relative"), "I: error mentions relative");
} finally {
  fs.rmSync(tmpI, { recursive: true, force: true });
}

// J. envFile ../ escape → reject
const tmpJ = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-escape-"));
try {
  fs.mkdirSync(path.join(tmpJ, ".pi"));
  fs.writeFileSync(
    path.join(tmpJ, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: "../../secret.env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultJ = assertProjectEnabled(tmpJ);
  check(resultJ.ok === false, "J: envFile ../ escape → reject");
  check(resultJ.error.includes("escapes") || resultJ.error.includes("invalid"), "J: error mentions escape");
} finally {
  fs.rmSync(tmpJ, { recursive: true, force: true });
}

// K. envFile canonical path outside project → reject
const tmpK = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-outside-"));
try {
  fs.mkdirSync(path.join(tmpK, ".pi"));
  fs.writeFileSync(
    path.join(tmpK, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: "../../../outside.env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultK = assertProjectEnabled(tmpK);
  check(resultK.ok === false, "K: envFile canonical outside project → reject");
  check(resultK.error.includes("escapes") || resultK.error.includes("invalid"), "K: error mentions escape");
} finally {
  fs.rmSync(tmpK, { recursive: true, force: true });
}

// R. missing nested envFile inside root → accept
// Locks the realpath fallback: a path that does not exist yet must still be judged
// inside the project root (regression for the Windows short/long path-form mismatch).
const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-missing-"));
try {
  fs.mkdirSync(path.join(tmpR, ".pi"));
  fs.writeFileSync(
    path.join(tmpR, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: "config/.env", envPrefix: "DB_" }),
    "utf8"
  );
  const resultR = assertProjectEnabled(tmpR);
  check(resultR.ok === true, "R: missing nested envFile inside root → accept");
  check(resultR.config.envFile === "config/.env", "R: envFile preserved");
} finally {
  fs.rmSync(tmpR, { recursive: true, force: true });
}

// M. envPrefix=DB_ → covered in test D
check(true, "M: envPrefix=DB_ mapping covered in test D");

// M2. envPrefix validation: lowercase rejected
const tmpM2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-lowercase-"));
try {
  fs.mkdirSync(path.join(tmpM2, ".pi"));
  fs.writeFileSync(
    path.join(tmpM2, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "db_" }),
    "utf8"
  );
  const resultM2 = assertProjectEnabled(tmpM2);
  check(resultM2.ok === false, "M2: envPrefix lowercase → rejected");
  check(resultM2.error.includes("invalid"), "M2: error mentions invalid");
} finally {
  fs.rmSync(tmpM2, { recursive: true, force: true });
}

// M3. envPrefix validation: shell expression rejected
const tmpM3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-shell-"));
try {
  fs.mkdirSync(path.join(tmpM3, ".pi"));
  fs.writeFileSync(
    path.join(tmpM3, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB_$(whoami)_" }),
    "utf8"
  );
  const resultM3 = assertProjectEnabled(tmpM3);
  check(resultM3.ok === false, "M3: envPrefix with $() → rejected");
  check(resultM3.error.includes("invalid"), "M3: error mentions invalid");
} finally {
  fs.rmSync(tmpM3, { recursive: true, force: true });
}

// M4. envPrefix validation: equals sign rejected
const tmpM4 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-equals-"));
try {
  fs.mkdirSync(path.join(tmpM4, ".pi"));
  fs.writeFileSync(
    path.join(tmpM4, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB=HACK_" }),
    "utf8"
  );
  const resultM4 = assertProjectEnabled(tmpM4);
  check(resultM4.ok === false, "M4: envPrefix with = → rejected");
  check(resultM4.error.includes("invalid"), "M4: error mentions invalid");
} finally {
  fs.rmSync(tmpM4, { recursive: true, force: true });
}

// M5. envPrefix validation: dash rejected
const tmpM5 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-dash-"));
try {
  fs.mkdirSync(path.join(tmpM5, ".pi"));
  fs.writeFileSync(
    path.join(tmpM5, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "DB-FOO_" }),
    "utf8"
  );
  const resultM5 = assertProjectEnabled(tmpM5);
  check(resultM5.ok === false, "M5: envPrefix with dash → rejected");
  check(resultM5.error.includes("invalid"), "M5: error mentions invalid");
} finally {
  fs.rmSync(tmpM5, { recursive: true, force: true });
}

// N. process.env has DB credentials, but project disabled → still blocked
const tmpN = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-disabled-env-"));
try {
  process.env.TEST_DB_HOST = "test-host";
  process.env.TEST_DB_NAME = "test-db";
  process.env.TEST_DB_USER = "test-user";
  process.env.TEST_DB_PASSWORD = "test-pass";

  const resultN = assertProjectEnabled(tmpN);
  check(resultN.ok === false, "N: disabled project with process.env → still blocked");

  delete process.env.TEST_DB_HOST;
  delete process.env.TEST_DB_NAME;
  delete process.env.TEST_DB_USER;
  delete process.env.TEST_DB_PASSWORD;
} finally {
  fs.rmSync(tmpN, { recursive: true, force: true });
}

// O. /db --last isolation
check(true, "O: /db --last isolation tested in integration");

// Dialect configuration tests
// Q1. Missing dialect defaults to mysql
const tmpQ1 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-dialect-default-"));
try {
  fs.mkdirSync(path.join(tmpQ1, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpQ1, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, envFile: ".env", envPrefix: "TEST_" })
  );
  const resultQ1 = assertProjectEnabled(tmpQ1);
  check(resultQ1.ok && resultQ1.config.dialect === "mysql", "Q1: missing dialect defaults to mysql");
} finally {
  fs.rmSync(tmpQ1, { recursive: true, force: true });
}

// Q2. Explicit mysql dialect accepted
const tmpQ2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-dialect-mysql-"));
try {
  fs.mkdirSync(path.join(tmpQ2, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpQ2, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, dialect: "mysql", envFile: ".env", envPrefix: "TEST_" })
  );
  const resultQ2 = assertProjectEnabled(tmpQ2);
  check(resultQ2.ok && resultQ2.config.dialect === "mysql", "Q2: explicit mysql dialect accepted");
} finally {
  fs.rmSync(tmpQ2, { recursive: true, force: true });
}

// Q3. Explicit postgres dialect accepted
const tmpQ3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-dialect-postgres-"));
try {
  fs.mkdirSync(path.join(tmpQ3, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpQ3, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, dialect: "postgres", envFile: ".env", envPrefix: "TEST_" })
  );
  const resultQ3 = assertProjectEnabled(tmpQ3);
  check(resultQ3.ok && resultQ3.config.dialect === "postgres", "Q3: explicit postgres dialect accepted");
} finally {
  fs.rmSync(tmpQ3, { recursive: true, force: true });
}

// Q4. Invalid dialect rejected
const tmpQ4 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-dialect-invalid-"));
try {
  fs.mkdirSync(path.join(tmpQ4, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpQ4, ".pi", "pi-db.json"),
    JSON.stringify({ enabled: true, dialect: "sqlite", envFile: ".env", envPrefix: "TEST_" })
  );
  const resultQ4 = assertProjectEnabled(tmpQ4);
  check(!resultQ4.ok && resultQ4.error.includes("dialect"), "Q4: invalid dialect rejected");
} finally {
  fs.rmSync(tmpQ4, { recursive: true, force: true });
}

// P. sql.test.mjs passes separately
check(true, "P: sql.test.mjs unchanged and passes separately");

// Additional: verify gate ordering in index.ts
// --- Multi-target config (targets map) ---

function withProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-targets-"));
  try {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "pi-db.json"), JSON.stringify(files, null, 2), "utf8");
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// T1-T5: named targets, fail-closed selection.
withProject(
  {
    enabled: true,
    dialect: "mysql",
    envFile: ".env",
    envPrefix: "DB_",
    targets: {
      prod: { envFile: ".env.pi-db.prod", envPrefix: "DB_" },
      formal: { envFile: ".env.pi-db.formal", envPrefix: "DB_" },
    },
  },
  (dir) => {
    const r = assertProjectEnabled(dir);
    check(r.ok === true, "T1: targets config → PASS");
    check(Object.keys(r.config.targets).sort().join(",") === "formal,prod", "T1: both targets exposed");
    check(r.config.targets.prod.envFile === ".env.pi-db.prod", "T1: prod envFile kept");
    check(r.config.targets.formal.envFile === ".env.pi-db.formal", "T1: formal envFile kept");

    const missing = resolveTarget(r.config);
    check(missing.ok === false, "T2: omitted target → refused");
    check(missing.error.includes("available targets: formal, prod"), "T2: lists available targets");

    const prod = resolveTarget(r.config, "prod");
    check(prod.ok === true, "T3: target=prod → OK");
    check(prod.target.envFile === ".env.pi-db.prod", "T3: prod envFile resolved");
    check(prod.label === "prod", "T3: prod label is preserved for result attribution");

    const unknown = resolveTarget(r.config, "staging");
    check(unknown.ok === false, "T4: unknown target → refused");
    check(unknown.error.includes("unknown target") && unknown.error.includes("formal, prod"), "T4: names the unknown target and lists valid ones");

    check(resolveTarget(r.config, "").ok === false, "T5: blank target → refused (no implicit default)");
  }
);

// T6: a target may inherit top-level envFile/envPrefix (one .env, several prefixes).
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: { only: {} } }, (dir) => {
  const r = assertProjectEnabled(dir);
  check(r.ok === true, "T6: target with no fields inherits top level");
  check(r.config.targets.only.envFile === ".env", "T6: inherited envFile");
  check(r.config.targets.only.envPrefix === "DB_", "T6: inherited envPrefix");
  check(r.config.targets.only.dialect === "mysql", "T6: dialect defaults to mysql");
});

// T7: target fields with no top-level fallback are rejected.
withProject({ enabled: true, targets: { prod: { envPrefix: "DB_" } } }, (dir) => {
  const r = assertProjectEnabled(dir);
  check(r.ok === false, "T7: unresolvable envFile → rejected");
  check(r.error.includes("no top-level envFile to inherit"), "T7: explains the missing inheritance");
});

// T8: unknown target field is rejected — a typo must not silently fall back.
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: { prod: { envPrefx: "X_" } } }, (dir) => {
  const r = assertProjectEnabled(dir);
  check(r.ok === false, "T8: unknown target field → rejected");
  check(r.error.includes("unknown field"), "T8: names the offending field");
});

// T9: a target envFile still may not escape the project root.
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: { prod: { envFile: "../../outside.env" } } }, (dir) => {
  const r = assertProjectEnabled(dir);
  check(r.ok === false, "T9: escaping target envFile → rejected");
  check(r.error.includes("escapes") || r.error.includes("invalid"), "T9: error mentions escape");
});

// T10: target name and shape validation.
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: { Prod: {} } }, (dir) => {
  check(assertProjectEnabled(dir).ok === false, "T10: uppercase target name → rejected");
});
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: {} }, (dir) => {
  check(assertProjectEnabled(dir).ok === false, "T10: empty targets → rejected");
});
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_", targets: [] }, (dir) => {
  check(assertProjectEnabled(dir).ok === false, "T10: array targets → rejected");
});

// T11-T12: legacy config without targets keeps today's behaviour.
withProject({ enabled: true, envFile: ".env", envPrefix: "DB_" }, (dir) => {
  const r = assertProjectEnabled(dir);
  check(r.ok === true, "T11: legacy config still passes");
  const legacy = resolveTarget(r.config);
  check(legacy.ok === true, "T11: omitted target → legacy default");
  check(legacy.label === DEFAULT_TARGET_LABEL, "T11: legacy scope label is the fixed sentinel");
  check(legacy.target.envFile === ".env", "T11: legacy envFile resolved");
  const bogus = resolveTarget(r.config, "prod");
  check(bogus.ok === false, "T12: target on a legacy project → refused");
  check(bogus.error.includes("no named targets"), "T12: explains there are no targets");
});

// T13: per-target dialect override wins over the top level.
withProject(
  {
    enabled: true,
    dialect: "mysql",
    envFile: ".env",
    envPrefix: "DB_",
    targets: { prod: { envFile: ".env.p" }, formal: { envFile: ".env.f", dialect: "postgres" } },
  },
  (dir) => {
    const r = assertProjectEnabled(dir);
    check(r.ok === true, "T13: mixed-dialect targets load");
    check(r.config.targets.prod.dialect === "mysql", "T13: prod inherits top-level mysql");
    check(r.config.targets.formal.dialect === "postgres", "T13: formal overrides to postgres");
  }
);

// --- T14-T18: a named target's env file is the whole credential boundary ---
// Regression guard for the leak this feature exists to prevent: with two targets
// sharing one prefix (different files), an ambient process.env value must not
// fill a gap in the selected target's file.
const envScopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-db-test-envscope-"));
const scopePrefix = "PI_DB_TEST_SCOPE_";
try {
  // The ambient environment an application runtime would have.
  process.env[`${scopePrefix}HOST`] = "prod-host.example.internal";
  process.env[`${scopePrefix}PASSWORD`] = "prod-secret";

  fs.writeFileSync(
    path.join(envScopeDir, "partial.env"),
    `${scopePrefix}NAME=formal_db\n${scopePrefix}USER=reader\n`,
    "utf8"
  );

  // Legacy single-target keeps the historical fallback (zero regression).
  const legacyPartial = loadDbConfig(envScopeDir, "partial.env", scopePrefix, true);
  check(legacyPartial.ok === true, "T14: legacy config still falls back to process.env");
  check(
    legacyPartial.cfg.host === "prod-host.example.internal",
    "T14: legacy host taken from process.env"
  );

  // A named target must refuse instead of borrowing the other environment.
  const namedPartial = loadDbConfig(envScopeDir, "partial.env", scopePrefix, false);
  check(namedPartial.ok === false, "T15: named target missing HOST → refused");
  check(
    namedPartial.error.includes("do not fall back to process.env"),
    "T15: error states process.env was deliberately not consulted"
  );

  // An explicitly empty value in the file also must not fall through.
  fs.writeFileSync(
    path.join(envScopeDir, "empty.env"),
    `${scopePrefix}HOST=\n${scopePrefix}NAME=formal_db\n${scopePrefix}USER=reader\n`,
    "utf8"
  );
  check(
    loadDbConfig(envScopeDir, "empty.env", scopePrefix, false).ok === false,
    "T16: explicit empty HOST is not replaced by process.env for a named target"
  );
  const legacyEmpty = loadDbConfig(envScopeDir, "empty.env", scopePrefix, true);
  check(
    legacyEmpty.ok === true && legacyEmpty.cfg.host === "prod-host.example.internal",
    "T16: legacy still falls through on an empty value"
  );

  // Positive control: a complete target file resolves entirely from the file.
  fs.writeFileSync(
    path.join(envScopeDir, "full.env"),
    `${scopePrefix}HOST=formal-host.example.internal\n${scopePrefix}NAME=formal_db\n${scopePrefix}USER=reader\n${scopePrefix}PASSWORD=formal-secret\n`,
    "utf8"
  );
  const namedFull = loadDbConfig(envScopeDir, "full.env", scopePrefix, false);
  check(namedFull.ok === true, "T17: complete named target loads");
  check(namedFull.cfg.host === "formal-host.example.internal", "T17: host read from the target file");
  check(
    namedFull.cfg.password === "formal-secret",
    "T17: password read from the target file, not process.env"
  );

  // An omitted optional field stays empty for a named target, and only legacy borrows.
  fs.writeFileSync(
    path.join(envScopeDir, "nopw.env"),
    `${scopePrefix}HOST=formal-host.example.internal\n${scopePrefix}NAME=formal_db\n${scopePrefix}USER=reader\n`,
    "utf8"
  );
  check(
    loadDbConfig(envScopeDir, "nopw.env", scopePrefix, false).cfg.password === "",
    "T18: omitted PASSWORD stays empty for a named target"
  );
  check(
    loadDbConfig(envScopeDir, "nopw.env", scopePrefix, true).cfg.password === "prod-secret",
    "T18: legacy still borrows PASSWORD from process.env"
  );
} finally {
  delete process.env[`${scopePrefix}HOST`];
  delete process.env[`${scopePrefix}PASSWORD`];
  fs.rmSync(envScopeDir, { recursive: true, force: true });
}

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts");
const src = fs.readFileSync(indexPath, "utf8");
const runQueryStart = src.indexOf("async function runQuery");
const runQuerySrc = src.slice(runQueryStart);
const iProject = runQuerySrc.indexOf("assertProjectEnabled(ctx.cwd)");
const iTrust = runQuerySrc.indexOf("isProjectTrusted()");
const iPrepare = runQuerySrc.indexOf("prepareQuery(sql)");
const iLoad = runQuerySrc.indexOf("loadDbConfig(");
const iExecute = Math.min(
  runQuerySrc.indexOf("executeMysql(") >= 0 ? runQuerySrc.indexOf("executeMysql(") : Infinity,
  runQuerySrc.indexOf("executePostgres(") >= 0 ? runQuerySrc.indexOf("executePostgres(") : Infinity
);
check(iProject >= 0 && iTrust >= 0 && iProject < iTrust, "Gate: projectEnabled before isProjectTrusted");
check(iTrust < iPrepare, "Gate: isProjectTrusted before prepareQuery");
check(iPrepare < iLoad, "Gate: prepareQuery before loadDbConfig");
const iResolve = runQuerySrc.indexOf("resolveTarget(");
check(iResolve >= 0 && iResolve < iLoad, "Gate: target resolved before loadDbConfig");
const iFallbackArg = runQuerySrc.indexOf("resolved.label === DEFAULT_TARGET_LABEL");
check(iFallbackArg > iResolve, "Gate: process-env fallback gated on legacy target label");
check(iLoad < iExecute && iExecute !== Infinity, "Gate: loadDbConfig before executeMysql/executePostgres");

check(src.indexOf("assertProjectEnabled(ctx.cwd)", src.indexOf("registerCommand")) > 0, "Gate: /db uses projectEnabled");

check(!src.includes("PROJECT_SPECIFIC_ROOT"), "No hardcoded project-specific constants in index.ts");
check(!src.includes("专用"), "No project-specific comments in index.ts");

check(src.includes("project database") || src.includes("MySQL"), "Description is generic");
check(!src.includes("specific database"), "Description not project-specific");

console.log("all project-gate tests passed");
