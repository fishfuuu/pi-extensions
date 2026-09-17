import * as fs from "node:fs";
import * as path from "node:path";

/** One named connection target. Fields may inherit the top level. */
export type DbTarget = {
  envFile: string;
  envPrefix: string;
  dialect: "mysql" | "postgres";
};

/** Project configuration schema for pi-db */
export type ProjectConfig = {
  enabled: boolean;
  /** Database dialect: 'mysql' (default) or 'postgres' */
  dialect?: "mysql" | "postgres";
  /** Single-target (legacy) fields. Used only when `targets` is absent. */
  envFile?: string;
  envPrefix?: string;
  /**
   * Named targets. When present, every query must name one explicitly — there is
   * no default target, so the environment is never guessed.
   */
  targets?: Record<string, DbTarget>;
};

/** Scope label used by single-target (legacy) configs. */
export const DEFAULT_TARGET_LABEL = "__default__";

/** Configuration validation result */
export type ConfigResult =
  | { ok: true; config: ProjectConfig; projectRoot: string }
  | { ok: false; error: string };

const CONFIG_FILENAME = "pi-db.json";
const CONFIG_DIR = ".pi";

/** Target names stay predictable and shell-safe. */
const TARGET_NAME_RE = /^[a-z][a-z0-9_-]*$/;
/** Only these fields are allowed on a target entry. */
const TARGET_FIELDS = new Set(["envFile", "envPrefix", "dialect"]);

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
/** Normalize separators and case without touching the filesystem. */
function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

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
  return normalizePath(resolved);
}

/**
 * Validate envFile: must be relative and resolve to inside project root.
 */
function validateEnvFile(envFile: string, projectRoot: string): { ok: true } | { ok: false; error: string } {
  // Reject absolute paths
  if (path.isAbsolute(envFile)) {
    return { ok: false, error: "pi-db project configuration invalid: envFile must be relative" };
  }

  // Resolve against the already-canonicalized root and normalize the result the same
  // way canonicalPath does. canonicalPath() can only realpath a path that exists, so a
  // missing envFile used to keep the un-normalized form: on Windows the short (8.3) and
  // long path forms then diverged and a valid config was reported as escaping the root.
  const canonicalRoot = canonicalPath(projectRoot);
  const resolved = normalizePath(path.resolve(canonicalRoot, envFile));
  // Existing files are still realpathed, so a symlink that leaves the root stays rejected.
  const canonicalResolved = fs.existsSync(resolved) ? canonicalPath(resolved) : resolved;

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
 * Read a per-target string field, falling back to the top level.
 * Inheritance keeps the schema able to express "one .env, several prefixes"; a
 * project that wants a structural environment boundary simply gives each target
 * its own envFile.
 */
function inheritedString(
  entry: Record<string, unknown>,
  top: Record<string, unknown>,
  key: "envFile" | "envPrefix",
  targetName: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (key in entry) {
    const value = entry[key];
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `pi-db project configuration invalid: targets."${targetName}".${key} must be a string`,
      };
    }
    return { ok: true, value };
  }
  const inherited = top[key];
  if (typeof inherited === "string") return { ok: true, value: inherited };
  return {
    ok: false,
    error: `pi-db project configuration invalid: targets."${targetName}" needs ${key}, and there is no top-level ${key} to inherit`,
  };
}

/**
 * Resolve which target a query should use.
 *
 * Fail-closed by design: when a project defines targets, a query that names no
 * target is refused rather than silently using one environment.
 */
export function resolveTarget(
  config: ProjectConfig,
  requested?: string
): { ok: true; target: DbTarget; label: string } | { ok: false; error: string } {
  const requestedName = typeof requested === "string" ? requested.trim() : "";
  const targets = config.targets;

  if (targets && Object.keys(targets).length > 0) {
    const names = Object.keys(targets).sort();
    const available = names.join(", ");
    if (!requestedName) {
      return { ok: false, error: `target is required; available targets: ${available}` };
    }
    const target = targets[requestedName];
    if (!target) {
      return { ok: false, error: `unknown target "${requestedName}"; available targets: ${available}` };
    }
    return { ok: true, target, label: requestedName };
  }

  if (requestedName) {
    return {
      ok: false,
      error: `this project defines no named targets; omit target (got "${requestedName}")`,
    };
  }

  if (config.envFile === undefined || config.envPrefix === undefined) {
    return {
      ok: false,
      error:
        "pi-db project configuration invalid: envFile and envPrefix are required when no targets are defined",
    };
  }

  return {
    ok: true,
    target: {
      envFile: config.envFile,
      envPrefix: config.envPrefix,
      dialect: config.dialect ?? "mysql",
    },
    label: DEFAULT_TARGET_LABEL,
  };
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

  // Validate dialect (optional, defaults to mysql). Top level doubles as the
  // per-target default.
  let topDialect: "mysql" | "postgres" = "mysql";
  if ("dialect" in obj) {
    if (obj.dialect !== "mysql" && obj.dialect !== "postgres") {
      return {
        ok: false,
        error: "pi-db project configuration invalid: dialect must be 'mysql' or 'postgres'",
      };
    }
    topDialect = obj.dialect as "mysql" | "postgres";
  }

  // Top-level envFile/envPrefix, when present, are validated even in targets mode
  // so a stale value cannot hide.
  if ("envFile" in obj && typeof obj.envFile !== "string") {
    return { ok: false, error: "pi-db project configuration invalid: envFile must be a string" };
  }
  if (typeof obj.envFile === "string") {
    const envFileCheck = validateEnvFile(obj.envFile, projectRoot);
    if (!envFileCheck.ok) return envFileCheck;
  }
  if ("envPrefix" in obj && typeof obj.envPrefix !== "string") {
    return { ok: false, error: "pi-db project configuration invalid: envPrefix must be a string" };
  }
  if (typeof obj.envPrefix === "string") {
    const envPrefixCheck = validateEnvPrefix(obj.envPrefix);
    if (!envPrefixCheck.ok) return envPrefixCheck;
  }

  const rawEnvFile = typeof obj.envFile === "string" ? obj.envFile : undefined;
  const rawEnvPrefix = typeof obj.envPrefix === "string" ? obj.envPrefix : undefined;

  // No targets → legacy single-target behaviour, unchanged.
  if (obj.targets === undefined) {
    if (rawEnvFile === undefined) {
      return { ok: false, error: "pi-db project configuration invalid: envFile must be a string" };
    }
    if (rawEnvPrefix === undefined) {
      return { ok: false, error: "pi-db project configuration invalid: envPrefix must be a string" };
    }
    return {
      ok: true,
      config: { enabled: true, dialect: topDialect, envFile: rawEnvFile, envPrefix: rawEnvPrefix },
      projectRoot,
    };
  }

  // Targets mode. Top-level envFile/envPrefix are inheritance defaults only; they
  // are never used as an implicit "default target".
  if (!obj.targets || typeof obj.targets !== "object" || Array.isArray(obj.targets)) {
    return { ok: false, error: "pi-db project configuration invalid: targets must be an object" };
  }
  const rawTargets = obj.targets as Record<string, unknown>;
  const targetNames = Object.keys(rawTargets);
  if (targetNames.length === 0) {
    return { ok: false, error: "pi-db project configuration invalid: targets must define at least one target" };
  }

  const targets: Record<string, DbTarget> = {};
  for (const name of targetNames) {
    if (!TARGET_NAME_RE.test(name)) {
      return {
        ok: false,
        error: `pi-db project configuration invalid: target name "${name}" must match /^[a-z][a-z0-9_-]*$/`,
      };
    }
    const entry = rawTargets[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `pi-db project configuration invalid: targets."${name}" must be an object` };
    }
    const entryObj = entry as Record<string, unknown>;
    for (const key of Object.keys(entryObj)) {
      // Reject unknown keys: a typo like "envPrefx" would otherwise fall back to
      // inheritance and silently query the wrong environment.
      if (!TARGET_FIELDS.has(key)) {
        return {
          ok: false,
          error: `pi-db project configuration invalid: targets."${name}" has unknown field "${key}" (allowed: envFile, envPrefix, dialect)`,
        };
      }
    }

    const envFileValue = inheritedString(entryObj, obj, "envFile", name);
    if (!envFileValue.ok) return envFileValue;
    const envPrefixValue = inheritedString(entryObj, obj, "envPrefix", name);
    if (!envPrefixValue.ok) return envPrefixValue;

    const envFileCheck = validateEnvFile(envFileValue.value, projectRoot);
    if (!envFileCheck.ok) return envFileCheck;
    const envPrefixCheck = validateEnvPrefix(envPrefixValue.value);
    if (!envPrefixCheck.ok) return envPrefixCheck;

    let targetDialect = topDialect;
    if ("dialect" in entryObj) {
      if (entryObj.dialect !== "mysql" && entryObj.dialect !== "postgres") {
        return {
          ok: false,
          error: `pi-db project configuration invalid: targets."${name}".dialect must be 'mysql' or 'postgres'`,
        };
      }
      targetDialect = entryObj.dialect as "mysql" | "postgres";
    }

    targets[name] = {
      envFile: envFileValue.value,
      envPrefix: envPrefixValue.value,
      dialect: targetDialect,
    };
  }

  return {
    ok: true,
    config: {
      enabled: true,
      dialect: topDialect,
      envFile: rawEnvFile,
      envPrefix: rawEnvPrefix,
      targets,
    },
    projectRoot,
  };
}
