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
assert.equal(pkg.peerDependencies["@quintinshaw/pi-dynamic-workflows"], ">=3.11.0");

const expectedExtensions = [
  "./extensions/pi-check/index.ts",
  "./extensions/pi-quota/index.ts",
  "./extensions/pi-db/index.ts",
];
assert.deepEqual(pkg.pi.extensions, expectedExtensions);

for (const relativePath of expectedExtensions) {
  assert.equal(fs.existsSync(path.join(root, relativePath)), true, `missing ${relativePath}`);
}
for (const relativePath of [
  "extensions/pi-check/README.md",
  "extensions/pi-quota/README.md",
  "extensions/pi-db/README.md",
  "LICENSE",
]) {
  assert.equal(fs.existsSync(path.join(root, relativePath)), true, `missing ${relativePath}`);
}

const installerPath = path.join(root, "scripts", "install.ps1");
assert.equal(fs.existsSync(installerPath), true, "scripts/install.ps1 must exist");
const installer = fs.readFileSync(installerPath, "utf8");
assert.match(
  installer,
  /ValidateSet\('pi-check', 'pi-quota', 'pi-db', 'pi-tools-stats', 'pi-bash-guard', 'pi-tool-presets', 'pi-worker-selector', 'all'\)/,
  "installer ValidateSet must include opt-in pi-tools-stats and pi-bash-guard",
);
assert.match(
  installer,
  /\$DefaultPlugins = @\('pi-check', 'pi-quota', 'pi-db'\)/,
  "installer all/default is check, quota, db only",
);
assert.match(
  installer,
  /\$AllowedPlugins = @\('pi-check', 'pi-quota', 'pi-db', 'pi-tools-stats', 'pi-bash-guard', 'pi-tool-presets', 'pi-worker-selector'\)/,
  "installer AllowedPlugins includes opt-in pi-tools-stats and pi-bash-guard",
);
// Install dependency contract: pi-worker-selector imports ../pi-quota/snapshot.ts
// at runtime, so the dependency is that FILE, not merely the pi-quota directory.
// Installing the selector must queue pi-quota when missing, must leave an
// existing pi-quota untouched, and must fail fast with an upgrade hint when the
// installed pi-quota predates snapshot.ts (no auto-update, no broken install).
assert.match(
  installer,
  /if \(\$Plugin -eq 'pi-worker-selector'\) \{[\s\S]{0,800}?queueing it first/,
  "installer must auto-install pi-quota before pi-worker-selector when it is missing",
);
assert.match(
  installer,
  /'pi-quota\\snapshot\.ts'/,
  "installer dependency check must test pi-quota's snapshot.ts, not just the directory",
);
assert.match(
  installer,
  /snapshot\.ts[\s\S]{0,400}?pi-quota -Update/,
  "installer must fail fast with the pi-quota -Update hint when installed pi-quota predates snapshot.ts",
);
assert.match(
  installer,
  /FailedPlugins -contains 'pi-quota'[\s\S]{0,200}?Skipping pi-worker-selector/,
  "installer must skip pi-worker-selector when the pi-quota install failed",
);

console.log("9/9 native Pi package contract tests passed");
