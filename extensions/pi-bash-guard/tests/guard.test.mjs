import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the audit log at a temp dir before the extension module is imported,
// because index.ts resolves the agent dir at module load time.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-guard-canary-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: register } = await import("../index.ts");

const logPath = path.join(agentDir, "pi-bash-guard.log");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function buildHandler() {
  let handler;
  const pi = {
    on(event, fn) {
      if (event === "tool_call") handler = fn;
    },
    registerCommand() {},
    registerTool() {},
  };
  register(pi);
  assert.equal(typeof handler, "function", "extension must register a tool_call handler");
  return handler;
}

const handler = buildHandler();

function context({ confirm, hasUI = true, mode = "tui" } = {}) {
  return { hasUI, mode, ui: confirm ? { confirm } : undefined };
}

function bashEvent(command) {
  return { toolName: "bash", input: { command } };
}

function powershellEvent(command) {
  return { toolName: "powershell", input: { command } };
}

function readLog() {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

await test("approved dangerous command is allowed through", async () => {
  let asked = 0;
  const result = await handler(
    bashEvent("rm -rf /tmp/pi-bash-guard-canary"),
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.equal(asked, 1, "the dialog must be shown exactly once");
  assert.equal(result, undefined, "approval must not block");
});

await test("denied dangerous command is blocked with a reason", async () => {
  const result = await handler(bashEvent("git push --force origin main"), context({ confirm: async () => false }));
  assert.ok(result && result.block === true, "denial must block");
  assert.match(result.reason, /force push/);
  assert.match(result.reason, /not approved/);
});

await test("no dialog-capable UI fails closed", async () => {
  const result = await handler(bashEvent("rm -rf /tmp/x"), context({ hasUI: false }));
  assert.ok(result && result.block === true, "missing UI must block");
  assert.match(result.reason, /no dialog-capable UI/);
});

await test("print/json mode fails closed", async () => {
  const result = await handler(bashEvent("npm publish"), context({ hasUI: false, mode: "print" }));
  assert.ok(result && result.block === true);
});

await test("a failing dialog fails closed", async () => {
  const result = await handler(
    bashEvent("rm -rf /tmp/x"),
    context({
      confirm: async () => {
        throw new Error("dialog exploded");
      },
    }),
  );
  assert.ok(result && result.block === true, "dialog error must block");
  assert.match(result.reason, /dialog failed/);
});

await test("a non-true dialog result fails closed", async () => {
  const result = await handler(bashEvent("rm -rf /tmp/x"), context({ confirm: async () => undefined }));
  assert.ok(result && result.block === true, "non-true result must block");
});

await test("safe commands never prompt", async () => {
  let asked = 0;
  for (const command of ["ls -la", "git status", "git push origin main", "rm file.txt", "cat .env"]) {
    const result = await handler(bashEvent(command), context({ confirm: async () => ((asked += 1), true) }));
    assert.equal(result, undefined, `${command} must not block`);
  }
  assert.equal(asked, 0, "safe commands must not open a dialog");
});

await test("non-bash tools are ignored", async () => {
  let asked = 0;
  const result = await handler(
    { toolName: "read", input: { path: ".env" } },
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.equal(result, undefined);
  assert.equal(asked, 0);
});

await test("powershell tool: denied dangerous command is blocked", async () => {
  // Pi ships a builtin powershell tool (PowerShellToolInput = BashToolInput).
  // The same Remove-Item pattern the rules promise to guard must not bypass
  // the guard just because it runs through that tool.
  let asked = 0;
  const result = await handler(
    powershellEvent("Remove-Item -Recurse -Force C:\\data\\important"),
    context({ confirm: async () => ((asked += 1), false) }),
  );
  assert.equal(asked, 1, "the dialog must be shown exactly once");
  assert.ok(result && result.block === true, "denial must block");
  assert.match(result.reason, /PowerShell recursive force delete/);
  assert.match(result.reason, /not approved/);
});

await test("powershell tool: no dialog-capable UI fails closed", async () => {
  const result = await handler(
    powershellEvent("Remove-Item -Recurse -Force C:\\data\\important"),
    context({ hasUI: false }),
  );
  assert.ok(result && result.block === true, "missing UI must block");
  assert.match(result.reason, /no dialog-capable UI/);
});

await test("powershell tool: safe commands never prompt", async () => {
  let asked = 0;
  const result = await handler(
    powershellEvent("Get-ChildItem -Name"),
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.equal(result, undefined, "safe powershell must not block");
  assert.equal(asked, 0, "safe powershell must not open a dialog");
});

await test("a missing command does not crash or prompt", async () => {
  let asked = 0;
  const result = await handler(
    { toolName: "bash", input: {} },
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.equal(result, undefined);
  assert.equal(asked, 0);
});

await test("a timeout-style denial is recorded as timedOut", async () => {
  process.env.PI_BASH_GUARD_TIMEOUT_MS = "50";
  const result = await handler(
    bashEvent("rm -rf /tmp/x"),
    context({
      confirm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return false;
      },
    }),
  );
  delete process.env.PI_BASH_GUARD_TIMEOUT_MS;
  assert.ok(result && result.block === true, "timeout must block");
  const entry = readLog().at(-1);
  assert.equal(entry.timedOut, true, "a denial at the dialog deadline must be flagged as timedOut");
});

await test("audit log records a fingerprint, never the command text", async () => {
  const secret = "git push --force origin release/SUPERSECRETTOKEN-BRANCH";
  await handler(bashEvent(secret), context({ confirm: async () => false }));

  const raw = fs.readFileSync(logPath, "utf8");
  assert.equal(raw.includes("SUPERSECRETTOKEN"), false, "the log must not contain command content");
  assert.equal(raw.includes(secret), false, "the log must not contain command content");

  const entry = readLog().at(-1);
  assert.equal(entry.rule, "git-force-push");
  assert.match(entry.commandSha256, /^[0-9a-f]{16}$/);
  assert.equal(entry.commandLength, secret.length);
  assert.equal(entry.outcome, "denied");
  assert.equal(entry.hasUI, true);
  assert.equal(entry.mode, "tui");
  assert.equal(typeof entry.elapsedMs, "number");
});

await test("every audit entry carries the decision context", async () => {
  const entries = readLog();
  assert.ok(entries.length >= 5, "the canary should have produced audit entries");
  for (const entry of entries) {
    assert.equal(typeof entry.at, "string");
    assert.equal(typeof entry.rule, "string");
    assert.equal(typeof entry.why, "string");
    assert.ok(
      ["approved", "denied", "no-ui", "error", "confirm-requested"].includes(entry.outcome),
      `bad outcome: ${entry.outcome}`,
    );
    assert.match(entry.commandSha256, /^[0-9a-f]{16}$/);
    assert.equal(typeof entry.commandLength, "number");
  }
});

await test("policy allow: no dialog, direct pass", async () => {
  fs.writeFileSync(
    path.join(agentDir, "pi-bash-guard.json"),
    JSON.stringify({ enabled: true, default: { "recursive-delete": "allow" } }),
    "utf8",
  );
  let asked = 0;
  const result = await handler(
    bashEvent("rm -rf /tmp/pi-guard-policy-allow"),
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.equal(result, undefined, "allow must not block");
  assert.equal(asked, 0, "allow must not open a dialog");
});

await test("policy block: no dialog, direct reject", async () => {
  fs.writeFileSync(
    path.join(agentDir, "pi-bash-guard.json"),
    JSON.stringify({ enabled: true, default: { "recursive-delete": "block" } }),
    "utf8",
  );
  let asked = 0;
  const result = await handler(
    bashEvent("rm -rf /tmp/pi-guard-policy-block"),
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.ok(result && result.block === true, "block policy must block");
  assert.match(result.reason, /policy: block/);
  assert.equal(asked, 0, "block must not open a dialog");
});

await test("policy confirm with no UI fails closed", async () => {
  fs.writeFileSync(
    path.join(agentDir, "pi-bash-guard.json"),
    JSON.stringify({ enabled: true, default: { "recursive-delete": "confirm" } }),
    "utf8",
  );
  const result = await handler(bashEvent("rm -rf /tmp/pi-guard-policy-confirm"), context({ hasUI: false }));
  assert.ok(result && result.block === true, "confirm without UI must block");
  assert.match(result.reason, /no dialog-capable UI/);
});

await test("project override beats default and normalizes Windows paths", async () => {
  // Key uses backslashes + lowercase + trailing slash: must still match E:/Pi-Extensions/X
  fs.writeFileSync(
    path.join(agentDir, "pi-bash-guard.json"),
    JSON.stringify({
      enabled: true,
      default: { "recursive-delete": "block", publish: "block" },
      projects: { "e:/pi-extensions/sub": { "recursive-delete": "allow" } },
    }),
    "utf8",
  );
  const cwd = "E:/Pi-Extensions/Sub/deep";
  const guarded = await handler(
    bashEvent("rm -rf /tmp/x"),
    { hasUI: true, mode: "tui", cwd, ui: { confirm: async () => true } },
  );
  assert.equal(guarded, undefined, "project override (allow) must win over default (block)");
  // A category the project does not override inherits the default.
  const publishResult = await handler(
    bashEvent("npm publish"),
    { hasUI: true, mode: "tui", cwd, ui: { confirm: async () => true } },
  );
  assert.ok(publishResult && publishResult.block === true, "unoverridden category inherits default (block)");
  // Outside the project root the override must not apply.
  const outside = await handler(
    bashEvent("rm -rf /tmp/y"),
    { hasUI: true, mode: "tui", cwd: "C:/elsewhere", ui: { confirm: async () => true } },
  );
  assert.ok(outside && outside.block === true, "outside the project the default (block) still applies");
});

await test("corrupt JSON fails safe (guard enabled, built-in defaults)", async () => {
  fs.writeFileSync(path.join(agentDir, "pi-bash-guard.json"), "{ this is not json", "utf8");
  let asked = 0;
  const result = await handler(
    bashEvent("rm -rf /tmp/pi-guard-corrupt"),
    context({ confirm: async () => ((asked += 1), true) }),
  );
  assert.ok(result === undefined || result.block !== true, "fail-safe must not block a rm (built-in confirm applies)");
  assert.equal(asked, 1, "fail-safe confirm must still prompt");
  const entry = readLog().at(-1);
  assert.equal(entry.outcome, "approved", "fail-safe fallback behaves like the built-in default");
});

fs.rmSync(agentDir, { recursive: true, force: true });

console.log(`${passed}/${passed} pi-bash-guard canary tests passed`);
