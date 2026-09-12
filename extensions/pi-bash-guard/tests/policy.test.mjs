import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GUARD_CATEGORIES } from "../core.ts";
import {
  loadPolicyConfig,
  resolveEnabledForCwd,
  resolvePolicyForCwd,
} from "../policy.ts";

function writeConfig(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-guard-policy-"));
  const configPath = path.join(dir, "pi-bash-guard.json");
  if (json !== undefined) fs.writeFileSync(configPath, json, "utf8");
  return configPath;
}

function load(configPath) {
  return loadPolicyConfig(configPath, GUARD_CATEGORIES);
}

function resolve(config, cwd) {
  return resolvePolicyForCwd(config, cwd, GUARD_CATEGORIES);
}

const KNOWN = ["recursive-delete", "destructive-git", "credential-write", "system-destructive", "publish"];

test("no config → built-in defaults, enabled, no diagnostics", () => {
  const config = load(writeConfig(undefined));
  assert.equal(config.enabled, true);
  assert.equal(config.projects.length, 0);
  assert.equal(config.diagnostics.length, 0);
  const { policy: effective } = resolve(config, "C:/anywhere");
  assert.equal(effective["recursive-delete"], "confirm");
  assert.equal(effective["destructive-git"], "confirm");
  assert.equal(effective["credential-write"], "confirm");
  assert.equal(effective["system-destructive"], "block");
  assert.equal(effective.publish, "confirm");
});

test("config enabled=false → disabled", () => {
  const config = load(writeConfig(JSON.stringify({ enabled: false })));
  assert.equal(config.enabled, false);
});

test("default category override applies", () => {
  const config = load(
    writeConfig(JSON.stringify({ default: { "recursive-delete": "block", "system-destructive": "allow" } })),
  );
  assert.equal(config.defaultPolicy["recursive-delete"], "block");
  assert.equal(config.defaultPolicy["system-destructive"], "allow");
  const { policy } = resolve(config, "C:/anywhere");
  assert.equal(policy["credential-write"], "confirm", "untouched keeps built-in");
});

test("invalid action in default → falls back to built-in for that category", () => {
  const config = load(
    writeConfig(JSON.stringify({ default: { "recursive-delete": "yolo", "system-destructive": "block" } })),
  );
  assert.equal(config.defaultPolicy["recursive-delete"], undefined, "invalid action dropped");
  assert.equal(config.defaultPolicy["system-destructive"], "block");
  assert.ok(config.diagnostics.some((d) => d.includes("yolo")), "diagnostic recorded");
  const { policy } = resolve(config, "C:/x");
  assert.equal(policy["recursive-delete"], "confirm", "resolved policy falls back to built-in");
});

test("project override applies for cwd inside the root", () => {
  const config = load(
    writeConfig(
      JSON.stringify({
        default: { "recursive-delete": "confirm" },
        projects: { "E:\\pi-extensions": { "recursive-delete": "allow" } },
      }),
    ),
  );
  const { projectRoot, policy } = resolve(config, "E:/pi-extensions/extensions");
  assert.equal(projectRoot, "e:/pi-extensions");
  assert.equal(policy["recursive-delete"], "allow");
  assert.equal(policy["credential-write"], "confirm", "untouched inherits default");
});

test("cwd outside every project root → pure default", () => {
  const config = load(
    writeConfig(JSON.stringify({ projects: { "D:\\wealth-lab": { "recursive-delete": "allow" } } })),
  );
  const { projectRoot, policy } = resolve(config, "C:/elsewhere");
  assert.equal(projectRoot, undefined);
  assert.equal(policy["recursive-delete"], "confirm");
});

test("Windows path normalization: case, slashes, trailing slash, subdirs", () => {
  const config = load(writeConfig(JSON.stringify({ projects: { "e:/Pi-Extensions/": { publish: "block" } } })));
  for (const cwd of ["E:\\pi-extensions", "e:/pi-extensions/", "E:/Pi-Extensions/sub/dir"]) {
    const { projectRoot, policy } = resolve(config, cwd);
    assert.equal(projectRoot, "e:/pi-extensions", `root match for ${cwd}`);
    assert.equal(policy.publish, "block", `override applies for ${cwd}`);
  }
  const outside = resolve(config, "E:/pi-extensions-other");
  assert.equal(outside.projectRoot, undefined, "prefix-but-different dir must not match");
});

test("project override for an unlisted category inherits default", () => {
  const config = load(writeConfig(JSON.stringify({ projects: { "E:\\proj": { publish: "allow" } } })));
  const { policy } = resolve(config, "E:/proj");
  assert.equal(policy.publish, "allow", "overridden");
  assert.equal(policy["recursive-delete"], "confirm", "inherited from default");
});

test("invalid action in project override → ignored, inherits default", () => {
  const config = load(writeConfig(JSON.stringify({ projects: { "E:\\proj": { "recursive-delete": "maybe" } } })));
  assert.equal(config.projects[0].overrides["recursive-delete"], undefined, "invalid override dropped");
  assert.ok(config.diagnostics.some((d) => d.includes("invalid action")));
});

test("corrupt JSON → fail-safe defaults + diagnostic", () => {
  const config = load(writeConfig("{ this is not json ]"));
  assert.equal(config.enabled, true, "fail-safe keeps the guard enabled");
  assert.ok(config.diagnostics.length > 0, "diagnostic recorded");
  const { policy } = resolve(config, "C:/x");
  assert.equal(policy["recursive-delete"], "confirm", "resolved policy falls back to built-in");
});

test("config root not an object → fail-safe defaults", () => {
  const config = load(writeConfig(JSON.stringify([1, 2, 3])));
  assert.equal(config.enabled, true);
  const { policy } = resolve(config, "C:/x");
  assert.equal(policy["recursive-delete"], "confirm", "resolved policy falls back to built-in");
});

test("unknown category in config → dropped with diagnostic", () => {
  const config = load(writeConfig(JSON.stringify({ default: { "recursive-delete": "block", "made-up": "allow" } })));
  assert.equal(config.defaultPolicy["made-up"], undefined, "unknown category dropped");
  assert.ok(config.diagnostics.some((d) => d.includes("made-up")));
});

test("most specific project root wins when nested roots both match", () => {
  const config = load(
    writeConfig(
      JSON.stringify({
        projects: {
          "E:\\repos": { publish: "allow" },
          "E:\\repos\\wealth": { "system-destructive": "allow" },
        },
      }),
    ),
  );
  const insideWealth = resolve(config, "E:/repos/wealth/app");
  assert.equal(insideWealth.projectRoot, "e:/repos/wealth", "most specific root wins");
  assert.equal(insideWealth.policy["system-destructive"], "allow", "child override applies");
  assert.equal(insideWealth.policy.publish, "confirm", "parent overrides do not leak into the child");
  const elsewhere = resolve(config, "E:/repos/other");
  assert.equal(elsewhere.projectRoot, "e:/repos", "parent root applies outside the child");
  assert.equal(elsewhere.policy.publish, "allow", "parent override applies outside the child");
});

test("directory boundary: E:\\foo must not match E:\\foobar", () => {
  const config = load(writeConfig(JSON.stringify({ projects: { "E:\\foo": { publish: "block" } } })));
  const inside = resolve(config, "E:/foo/bar");
  assert.equal(inside.projectRoot, "e:/foo", "subdirectory matches");
  assert.equal(inside.policy.publish, "block", "override applies in the subdirectory");
  const outside = resolve(config, "E:/foobar");
  assert.equal(outside.projectRoot, undefined, "E:/foobar must NOT match E:\\foo");
  assert.equal(outside.policy.publish, "confirm", "no override outside the root");
});

test("project enabled=false disables the guard inside the project only", () => {
  const config = load(
    writeConfig(
      JSON.stringify({
        enabled: true,
        projects: { "e:/pi-guard-project-x": { enabled: false } },
      }),
    ),
  );
  const inside = resolveEnabledForCwd(config, "E:/pi-guard-project-x/deep");
  assert.equal(inside.effective, false, "disabled inside the project");
  assert.equal(inside.globalEnabled, true);
  assert.equal(inside.projectEnabled, false);
  const outside = resolveEnabledForCwd(config, "C:/elsewhere");
  assert.equal(outside.effective, true, "still enabled outside the project");
});

test("project enabled=true re-enables inside the project when global is off", () => {
  const config = load(
    writeConfig(
      JSON.stringify({
        enabled: false,
        projects: { "e:/pi-guard-project-on": { enabled: true } },
      }),
    ),
  );
  const inside = resolveEnabledForCwd(config, "E:/pi-guard-project-on");
  assert.equal(inside.effective, true, "project override re-enables inside the project");
  const outside = resolveEnabledForCwd(config, "C:/elsewhere");
  assert.equal(outside.effective, false, "global off still applies outside the project");
});

test("project enabled unset → inherits global", () => {
  const config = load(
    writeConfig(
      JSON.stringify({ enabled: false, projects: { "e:/pi-guard-project-inherit": {} } }),
    ),
  );
  const inside = resolveEnabledForCwd(config, "E:/pi-guard-project-inherit/deep");
  assert.equal(inside.effective, false, "unset inherits global (false)");
  assert.equal(inside.projectEnabled, undefined);
});
