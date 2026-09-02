import * as fs from "node:fs";
import * as path from "node:path";

/** Project configuration schema for pi-db */
export type ProjectConfig = {
  enabled: boolean;
  envFile: string;
  envPrefix: string;
};

/** Configuration validation result */
export type ConfigResult =
  | { ok: true; config: ProjectConfig; projectRoot: string }
  | { ok: false; error: string };

const CONFIG_FILENAME = "pi-db.json";
const CONFIG_DIR = ".pi";

/**
 * Find project root by looking up for .pi/pi-db.json from cwd.
 * Returns the directory containing .pi (the project root).
 */
export function findProjectRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  const { root } = path.parse(current);

  while (true) {
    const configPath = path.join(current, CONFIG_DIR, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      return current;
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * Canonical path: resolve symlinks and normalize to lowercase forward slashes.
 */
export function canonicalPath(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      /* path may not exist (tests); keep resolved */
    }
  }
  return resolved.replace(/\\/g, "/").toLowerCase();
}

/**
 * Validate envFile: must be relative and resolve to inside project root.
 */
function validateEnvFile(envFile: string, projectRoot: string): { ok: true } | { ok: false; error: string } {
  // Reject absolute paths
  if (path.isAbsolute(envFile)) {
    return { ok: false, error: "pi-db project configuration invalid: envFile must be relative" };
  }

  const resolved = path.resolve(projectRoot, envFile);
  const canonicalResolved = canonicalPath(resolved);
  const canonicalRoot = canonicalPath(projectRoot);

  // Must be inside project root
  if (canonicalResolved !== canonicalRoot && !canonicalResolved.startsWith(`${canonicalRoot}/`)) {
    return { ok: false, error: "pi-db project configuration invalid: envFile escapes project root" };
  }

  return { ok: true };
}

/**
 * Validate envPrefix: must match /^[A-Z][A-Z0-9_]*$/
 * Examples: DB_, MYAPP_DB_, ANALYTICS_
 */
function validateEnvPrefix(envPrefix: string): { ok: true } | { ok: false; error: string } {
  if (typeof envPrefix !== "string" || envPrefix.trim().length === 0) {
    return { ok: false, error: "pi-db project configuration invalid: envPrefix must be non-empty" };
  }
  // Must start with uppercase letter, followed by uppercase letters, digits, or underscores
  if (!/^[A-Z][A-Z0-9_]*$/.test(envPrefix)) {
    return { ok: false, error: "pi-db project configuration invalid: envPrefix must match /^[A-Z][A-Z0-9_]*$/" };
  }
  return { ok: true };
}

/**
 * Load and validate project configuration from .pi/pi-db.json.
 * Returns disabled if no config exists or enabled is false.
 */
export function loadProjectConfig(cwd: string): ConfigResult {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    return { ok: false, error: "db_query disabled in this project" };
  }

  const configPath = path.join(projectRoot, CONFIG_DIR, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return { ok: false, error: "db_query disabled in this project" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "pi-db project configuration invalid: JSON parse error" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "pi-db project configuration invalid: not an object" };
  }

  const obj = parsed as Record<string, unknown>;

  // Check enabled field
  if (!("enabled" in obj) || obj.enabled !== true) {
    return { ok: false, error: "db_query disabled in this project" };
  }

  // Validate envFile
  if (typeof obj.envFile !== "string") {
    return { ok: false, error: "pi-db project configuration invalid: envFile must be a string" };
  }
  const envFileCheck = validateEnvFile(obj.envFile, projectRoot);
  if (!envFileCheck.ok) return envFileCheck;

  // Validate envPrefix
  if (typeof obj.envPrefix !== "string") {
    return { ok: false, error: "pi-db project configuration invalid: envPrefix must be a string" };
  }
  const envPrefixCheck = validateEnvPrefix(obj.envPrefix);
  if (!envPrefixCheck.ok) return envPrefixCheck;

  return {
    ok: true,
    config: {
      enabled: true,
      envFile: obj.envFile,
      envPrefix: obj.envPrefix,
    },
    projectRoot,
  };
}
