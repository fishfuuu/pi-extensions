import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");

assert.equal(fs.existsSync(packagePath), true, "root package.json must exist");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

assert.equal(pkg.private, true, "package must remain private to prevent npm publish");
assert.equal(pkg.license, "MIT");
assert.equal(pkg.keywords.includes("pi-package"), true);
assert.equal(pkg.dependencies.mysql2, "^3.24.2");
assert.equal(pkg.dependencies.pg, "^8.23.0");

const expectedExtensions = [
  "./extensions/pi-check/index.ts",
  "./extensions/pi-quota/index.ts",
  "./extensions/pi-db/index.ts",
  "./extensions/pi-tool-presets/index.ts",
];
assert.deepEqual(pkg.pi.extensions, expectedExtensions);

for (const relativePath of expectedExtensions) {
  assert.equal(fs.existsSync(path.join(root, relativePath)), true, `missing ${relativePath}`);
}
for (const relativePath of [
  "extensions/pi-check/README.md",
  "extensions/pi-quota/README.md",
  "extensions/pi-tool-presets/README.md",
  "LICENSE",
]) {
  assert.equal(fs.existsSync(path.join(root, relativePath)), true, `missing ${relativePath}`);
}

const installerPath = path.join(root, "scripts", "install.ps1");
assert.equal(fs.existsSync(installerPath), true, "scripts/install.ps1 must exist");
const installer = fs.readFileSync(installerPath, "utf8");
assert.match(
  installer,
  /ValidateSet\('pi-check', 'pi-quota', 'pi-db', 'pi-tool-presets', 'all'\)/,
  "installer ValidateSet must include pi-tool-presets",
);
assert.match(
  installer,
  /\$AllowedPlugins = @\('pi-check', 'pi-quota', 'pi-db', 'pi-tool-presets'\)/,
  "installer AllowedPlugins must include pi-tool-presets",
);

console.log("2/2 native Pi package contract tests passed");
