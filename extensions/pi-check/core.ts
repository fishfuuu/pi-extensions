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

export const CHECK_DIGEST_MAX_LINES = 40;
export const CHECK_DIGEST_MAX_CHARS = 4000;

export function digestCheckOutput(
  raw: string,
  maxLines = CHECK_DIGEST_MAX_LINES,
  maxChars = CHECK_DIGEST_MAX_CHARS,
): { text: string; truncated: boolean; lineCount: number } {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lineCount = lines.length;
  let truncated = lineCount > maxLines;
  let text = lines.slice(0, maxLines).join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}\n…`;
    truncated = true;
  }
  return { text, truncated, lineCount };
}

/** Prefill for the /check editor: beginner instructions + truncated digest. */
export function formatCheckEditorPrefill(checkName: string, rawOutput: string): string {
  const d = digestCheckOutput(rawOutput);
  const size = d.truncated
    ? `原始输出约 ${d.lineCount} 行，下面只保留前几段以免撑爆对话。`
    : `原始输出约 ${d.lineCount} 行。`;
  return [
    `检查器 ${checkName} 未通过。`,
    "",
    "你不需要看懂下面的技术输出。",
    "点「提交」：把这份摘要发给助手，让它判断该不该改、改哪些。",
    "点「关闭」：不发给助手。",
    "",
    size,
    "助手如需完整结果，应自己再跑同一条检查命令，不要猜测被截掉的部分。",
    "",
    "—— 摘要 ——",
    d.text,
  ].join("\n");
}

/** User message body after Submit on the /check output editor. */
export function checkFindingsUserMessage(checkName: string, editorText: string): string {
  return [
    `The user submitted /check ${checkName} findings from the review panel.`,
    "They may not understand the linter output. Explain briefly, then fix only issues in scope of the current work.",
    "Do not mass-autofix unrelated files. If the digest is truncated, re-run the project checker rather than inventing omitted findings.",
    "",
    editorText.trimEnd(),
  ].join("\n");
}
