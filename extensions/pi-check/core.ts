/**
 * Pure helper functions for pi-check
 * 
 * Extracted from index.ts to enable testing without Pi runtime dependencies.
 */

import * as path from "node:path";

/**
 * Check if a file path matches any of the given extensions (case-insensitive).
 */
export function matchesExtension(filePath: string, extensions: string[]): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return extensions.some((e) => e.toLowerCase() === ext);
}

/**
 * Check if a file path is within the checker's scope.
 * 
 * A checker without cwd covers the whole project.
 * A checker with cwd only covers files within that subdirectory.
 */
export function isInCheckScope(
  filePath: string,
  projectRoot: string,
  checkCwd?: string,
): boolean {
  if (!checkCwd) return true;
  const scope = path.resolve(projectRoot, checkCwd);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const rel = path.relative(scope, abs);
  // Outside the subtree => rel starts with ".."; a different drive => absolute.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Parse and validate a numeric configuration bound.
 * 
 * Returns fallback if undefined, "invalid" if out of range or not an integer.
 */
export function parseBound(
  value: unknown,
  fallback: number,
  max: number,
): number | "invalid" {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    return "invalid";
  }
  return value;
}
