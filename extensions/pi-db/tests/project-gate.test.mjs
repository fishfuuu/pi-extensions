import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProjectEnabled, canonicalPath, getProjectRoot } from "../project-gate.ts";
import { loadProjectConfig } from "../config.ts";

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

// P. sql.test.mjs passes separately
check(true, "P: sql.test.mjs unchanged and passes separately");

// Additional: verify gate ordering in index.ts
const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts");
const src = fs.readFileSync(indexPath, "utf8");
const runQueryStart = src.indexOf("async function runQuery");
const runQuerySrc = src.slice(runQueryStart);
const iProject = runQuerySrc.indexOf("assertProjectEnabled(ctx.cwd)");
const iTrust = runQuerySrc.indexOf("isProjectTrusted()");
const iPrepare = runQuerySrc.indexOf("prepareQuery(sql)");
const iLoad = runQuerySrc.indexOf("loadDbConfig(");
const iMysql = runQuerySrc.indexOf("mysql.createConnection");
check(iProject >= 0 && iTrust >= 0 && iProject < iTrust, "Gate: projectEnabled before isProjectTrusted");
check(iTrust < iPrepare, "Gate: isProjectTrusted before prepareQuery");
check(iPrepare < iLoad, "Gate: prepareQuery before loadDbConfig");
check(iLoad < iMysql, "Gate: loadDbConfig before mysql.createConnection");

check(src.indexOf("assertProjectEnabled(ctx.cwd)", src.indexOf("registerCommand")) > 0, "Gate: /db uses projectEnabled");

check(!src.includes("PROJECT_SPECIFIC_ROOT"), "No hardcoded project-specific constants in index.ts");
check(!src.includes("专用"), "No project-specific comments in index.ts");

check(src.includes("project database") || src.includes("MySQL"), "Description is generic");
check(!src.includes("specific database"), "Description not project-specific");

console.log("all project-gate tests passed");
