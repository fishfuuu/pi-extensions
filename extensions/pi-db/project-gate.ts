import { loadProjectConfig, canonicalPath as configCanonicalPath, type ProjectConfig } from "./config.ts";

export { canonicalPath } from "./config.ts";

/**
 * Check if db_query is enabled for the current project.
 * Returns project configuration if enabled, or error if disabled/invalid.
 */
export function assertProjectEnabled(
  cwd: string
): { ok: true; config: ProjectConfig; projectRoot: string } | { ok: false; error: string } {
  return loadProjectConfig(cwd);
}

/**
 * Get project root for the given cwd, or undefined if no config exists.
 * Used for lastResult scope isolation.
 */
export function getProjectRoot(cwd: string): string | undefined {
  const result = loadProjectConfig(cwd);
  return result.ok ? result.projectRoot : undefined;
}
