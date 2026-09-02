import assert from "node:assert/strict";
import path from "node:path";
import {
  isInCheckScope,
  matchesExtension,
  parseBound,
} from "../core.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("matches Python files case-insensitively", () => {
  assert.equal(matchesExtension("service/API.PY", [".py"]), true);
});

test("matches TypeScript and TSX independently", () => {
  assert.equal(matchesExtension("src/page.ts", [".ts", ".tsx"]), true);
  assert.equal(matchesExtension("src/page.tsx", [".ts", ".tsx"]), true);
});

test("rejects unrelated extensions", () => {
  assert.equal(matchesExtension("README.md", [".py", ".ts", ".tsx"]), false);
});

test("checker without cwd covers the project", () => {
  assert.equal(isInCheckScope("src/a.py", "C:/project"), true);
});

test("checker cwd contains nested files", () => {
  const root = path.resolve("C:/project");
  assert.equal(isInCheckScope("backend/api.py", root, "backend"), true);
});

test("checker cwd excludes sibling files", () => {
  const root = path.resolve("C:/project");
  assert.equal(isInCheckScope("frontend/page.tsx", root, "backend"), false);
});

test("numeric bounds accept valid values and reject invalid values", () => {
  assert.equal(parseBound(undefined, 60_000, 600_000), 60_000);
  assert.equal(parseBound(30_000, 60_000, 600_000), 30_000);
  assert.equal(parseBound(0, 60_000, 600_000), "invalid");
  assert.equal(parseBound(600_001, 60_000, 600_000), "invalid");
  assert.equal(parseBound(1.5, 60_000, 600_000), "invalid");
});

console.log(`${passed}/${passed} pi-check tests passed`);
