/**
 * pi-check - project-level diagnostics runner for Pi agent.
 *
 * A thin generic "check runner" base. It does NOT know any specific language.
 * Each project declares checks in <project>/.pi/checks.json: which file patterns
 * should mark a checker dirty, which command to run, and in which cwd.
 *
 * Mechanism (A' design):
 *   tool_result  -> if a changed file matches a checker's files glob, mark dirty
 *   turn_end     -> if any checker is dirty, run it (once per turn), collect
 *                   stdout/stderr, and notify the user of the status
 *   /check       -> manual one-shot run (notify + editor; never injects context)
 *   timeout/maxBuffer per checker; same-checker single-flight + one coalesced rerun
 *   /simplify    -> absorbed from pi-simplify (git-diff -> prompt -> followUp)
 *
 * V1 ships one real checker: vue-tsc (npm run typecheck) for Vue/TypeScript projects.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec, spawn, spawnSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface CheckConfig {
  name: string;
  enabled: boolean;
  /** Glob-ish extension list (e.g. [".vue", ".ts", ".tsx"]) that marks this check dirty. */
  extensions: string[];
  /** Working directory to run the command in (relative to project root). */
  cwd?: string;
  /** Shell command to run, e.g. "npm run typecheck". */
  command: string;
  /** Kill the process tree after this many ms. Default 60000. */
  timeoutMs?: number;
  /** Capture at most this many bytes of combined stdout+stderr. Default 262144. */
  maxBuffer?: number;
}

interface ProjectConfig {
  checks: CheckConfig[];
}

/* ------------------------------------------------------------------ */
/* Config loading                                                      */
/* ------------------------------------------------------------------ */

function loadProjectConfig(projectRoot: string): ProjectConfig {
  const file = path.join(projectRoot, ".pi", "checks.json");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return { checks: Array.isArray(parsed?.checks) ? parsed.checks : [] };
  } catch (e: unknown) {
    // No config file (or unreadable) => no checks for this project.
    return { checks: [] };
  }
}

/* ------------------------------------------------------------------ */
/* File matching                                                       */
/* ------------------------------------------------------------------ */

function matchesExtension(filePath: string, extensions: string[]): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return extensions.some((e) => e.toLowerCase() === ext);
}

/**
 * True when filePath lies inside the checker's cwd subtree.
 *
 * Extension match alone is not enough: a checker declaring
 * cwd "frontend/app" would otherwise be marked dirty by any .ts in the
 * repo (e.g. prototypes/*.js triggering the frontend linter), spending a
 * full lint run on a directory that does not contain the changed file.
 *
 * A checker without cwd covers the whole project, so it always matches.
 */
function isInCheckScope(filePath: string, projectRoot: string, checkCwd?: string): boolean {
  if (!checkCwd) return true;
  const scope = path.resolve(projectRoot, checkCwd);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const rel = path.relative(scope, abs);
  // Outside the subtree => rel starts with ".."; a different drive => absolute.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isWritableTool(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

/* ------------------------------------------------------------------ */
/* Command execution                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 256 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_MAX_BUFFER = 8 * 1024 * 1024;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  maxBuffer: number;
  timeoutMs: number;
  configError?: string;
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 8_000,
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, truncated, maxBuffer, timeoutMs });
    };
    const kill = () => {
      if (child.pid) killProcessTree(child.pid);
    };
    const onChunk = (chunk: string, which: "stdout" | "stderr") => {
      if (truncated || timedOut) return;
      if (which === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        truncated = true;
        kill();
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onChunk(chunk, "stdout"));
    child.stderr?.on("data", (chunk: string) => onChunk(chunk, "stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", () => finish(1));
    child.on("close", (code) => {
      if (timedOut) finish(124);
      else finish(typeof code === "number" ? code : 1);
    });
  });
}

function formatRunOutput(name: string, result: RunResult): string {
  const flags: string[] = [`checker: ${name}`];
  if (result.timedOut) flags.push(`TIMEOUT: process tree killed after ${result.timeoutMs}ms`);
  if (result.truncated) {
    flags.push(
      `OUTPUT_LIMIT_EXCEEDED: output truncated at maxBuffer ${result.maxBuffer} bytes; process terminated because output limit was exceeded`,
    );
  }
  const sections: string[] = [];
  if (flags.length) sections.push(`[pi-check] ${flags.join(" · ")}`);
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout) sections.push(`[stdout]\n${stdout}`);
  if (stderr) sections.push(`[stderr]\n${stderr}`);
  return sections.join("\n\n") || "(no output)";
}

function summarizeResult(name: string, result: RunResult): { label: string; failed: boolean } {
  if (result.timedOut) return { label: `TIMEOUT after ${result.timeoutMs}ms`, failed: true };
  if (result.truncated) {
    return {
      label: `OUTPUT_LIMIT_EXCEEDED (maxBuffer ${result.maxBuffer} bytes)`,
      failed: true,
    };
  }
  if (result.code === 0) return { label: "clean", failed: false };
  return { label: `FAILED (exit ${result.code})`, failed: true };
}

function parseBound(value: unknown, fallback: number, max: number): number | "invalid" {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    return "invalid";
  }
  return value;
}

function validateCheck(check: CheckConfig, projectRoot: string): {
  error?: string;
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
} {
  const cwd = check.cwd ? path.resolve(projectRoot, check.cwd) : projectRoot;
  if (!check.command || !check.command.trim()) {
    return { error: "command is empty", cwd, timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER };
  }
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { error: `cwd missing: ${check.cwd ?? "."}`, cwd, timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER };
    }
  } catch {
    return { error: `cwd missing: ${check.cwd ?? "."}`, cwd, timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER };
  }
  const timeoutMs = parseBound(check.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (timeoutMs === "invalid") {
    return { error: "timeoutMs must be an integer from 1 to 600000", cwd, timeoutMs: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER };
  }
  const maxBuffer = parseBound(check.maxBuffer, DEFAULT_MAX_BUFFER, MAX_MAX_BUFFER);
  if (maxBuffer === "invalid") {
    return { error: "maxBuffer must be an integer from 1 to 8388608", cwd, timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER };
  }
  return { cwd, timeoutMs, maxBuffer };
}

/* ------------------------------------------------------------------ */
/* /simplify (absorbed from pi-simplify)                              */
/* ------------------------------------------------------------------ */

function getChangedFiles(cwd: string): Promise<string[]> {
  const run = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { cwd, encoding: "utf-8" }, (_e, stdout) => resolve(stdout ?? ""));
    });
  // 分别执行两个 git 命令再合并：Windows cmd.exe 不支持 ";" 分隔符，
  // 拼接成单条命令会导致整条失败（返回空列表）。
  return Promise.all([
    run("git -c core.quotepath=false diff --name-only --diff-filter=ACM HEAD"),
    run("git -c core.quotepath=false ls-files --others --exclude-standard"),
  ]).then(([tracked, untracked]) => {
    const files = (tracked + "\n" + untracked)
      .split("\n").map((s) => s.trim()).filter(Boolean);
    return [...new Set(files)].filter((f) => !isNoise(f));
  });
}

/** 过滤非代码噪音：历史文档、pi 配置、图片/二进制、网络响应快照。 */
function isNoise(file: string): boolean {
  return (
    file.startsWith("docs/") ||
    file.startsWith(".pi/") ||
    file === ".pi-lens.json" ||
    /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(file) ||
    /\.network-response$/.test(file)
  );
}

function buildSimplifyPrompt(files: string[]): string {
  return [
    "Review the recently changed code for clarity, consistency, and maintainability. " +
      "Focus only on these changed files, do not broaden the scope:",
    files.map((f) => `- ${f}`).join("\n"),
  ].join("\n");
}

async function handleSimplifyCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const files = await getChangedFiles(ctx.cwd);
  if (files.length === 0) {
    ctx.ui.notify("No changed files found. Make some changes first.", "info");
    return;
  }
  const prompt = buildSimplifyPrompt(files);
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
  /* State is keyed per project root to avoid cross-session bleed. */
  const dirtyByProject = new Map<string, Set<string>>(); // projectRoot -> checker names
  const warnedUntrustedProjects = new Set<string>();
  /** Last finished run per checker, so /check --last can show it without rerunning. */
  const lastResults = new Map<string, { result: RunResult; at: number }>();
  /** Same-checker single-flight. Not a general queue. */
  const flights = new Map<string, { running: Promise<RunResult> | null; pending: boolean }>();

  function flightKey(projectRoot: string, name: string): string {
    return `${projectRoot}\0${name}`;
  }

  function requireTrustedProject(
    projectRoot: string,
    ctx: ExtensionContext | ExtensionCommandContext,
    alwaysNotify = false,
  ): boolean {
    if (ctx.isProjectTrusted()) {
      warnedUntrustedProjects.delete(projectRoot);
      return true;
    }
    if (alwaysNotify || !warnedUntrustedProjects.has(projectRoot)) {
      ctx.ui.notify("[pi-check] Project is not trusted; configured checks were skipped.", "warning");
      warnedUntrustedProjects.add(projectRoot);
    }
    return false;
  }

  function markDirty(projectRoot: string, name: string) {
    if (!dirtyByProject.has(projectRoot)) {
      dirtyByProject.set(projectRoot, new Set());
    }
    dirtyByProject.get(projectRoot)!.add(name);
  }

  function notifyAuto(ctx: ExtensionContext, check: CheckConfig, result: RunResult) {
    const { label, failed } = summarizeResult(check.name, result);
    if (!failed && !result.truncated && !result.timedOut) {
      // Clean: keep it quiet in the terminal, where stdout is visible anyway.
      // In RPC mode (Pi Web) stdout goes nowhere, so without an "info" notify a
      // passing checker is indistinguishable from one that never ran.
      console.log(`[pi-check] ${check.name}: clean`);
      if (ctx.mode === "rpc") {
        ctx.ui.notify(`[pi-check] ${check.name}: clean`, "info");
      }
      return;
    }
    ctx.ui.notify(
      `[pi-check] ${check.name}: ${label} — run /check ${check.name} for details`,
      "error",
    );
  }

  async function executeCheck(projectRoot: string, check: CheckConfig): Promise<RunResult> {
    const v = validateCheck(check, projectRoot);
    if (v.error) {
      return {
        code: 2,
        stdout: "",
        stderr: v.error,
        timedOut: false,
        truncated: false,
        maxBuffer: v.maxBuffer,
        timeoutMs: v.timeoutMs,
        configError: v.error,
      };
    }
    return runCommand(check.command, v.cwd, v.timeoutMs, v.maxBuffer);
  }

  /** One in-flight process per checker. Extra triggers collapse into one rerun. */
  async function runSerialized(
    projectRoot: string,
    check: CheckConfig,
  ): Promise<RunResult> {
    const key = flightKey(projectRoot, check.name);
    let slot = flights.get(key);
    if (!slot) {
      slot = { running: null, pending: false };
      flights.set(key, slot);
    }
    if (slot.running) {
      slot.pending = true;
      return slot.running;
    }
    const work = (async () => {
      try {
        let result = await executeCheck(projectRoot, check);
        if (slot.pending) {
          slot.pending = false;
          result = await executeCheck(projectRoot, check);
        }
        return result;
      } finally {
        if (slot.pending) {
          slot.pending = false;
          markDirty(projectRoot, check.name);
        }
      }
    })();
    slot.running = work;
    try {
      const result = await work;
      if (!result.configError) {
        lastResults.set(flightKey(projectRoot, check.name), { result, at: Date.now() });
      }
      return result;
    } finally {
      if (slot.running === work) slot.running = null;
    }
  }

  async function runChecksFor(projectRoot: string, ctx: ExtensionContext) {
    const names = dirtyByProject.get(projectRoot);
    if (!names || names.size === 0) return;
    if (!requireTrustedProject(projectRoot, ctx)) {
      names.clear();
      return;
    }
    const batch = [...names];
    names.clear();
    const cfg = loadProjectConfig(projectRoot);
    await Promise.all(
      batch.map(async (name) => {
        const check = cfg.checks.find((c) => c.name === name && c.enabled);
        if (!check) return;
        const result = await runSerialized(projectRoot, check);
        if (result.configError) {
          ctx.ui.notify(`[pi-check] ${check.name}: ${result.configError}`, "error");
          return;
        }
        notifyAuto(ctx, check, result);
      }),
    );
  }

  /* --------- tool_result: mark dirty on file writes --------- */
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (!isWritableTool(event.toolName)) return;
    const input = event.input as { path?: string };
    const filePath = input?.path;
    if (!filePath) return;

    const projectRoot = ctx.cwd;
    if (!requireTrustedProject(projectRoot, ctx)) return;
    const cfg = loadProjectConfig(projectRoot);
    for (const check of cfg.checks) {
      if (!check.enabled) continue;
      if (
        matchesExtension(filePath, check.extensions) &&
        isInCheckScope(filePath, projectRoot, check.cwd)
      ) {
        markDirty(projectRoot, check.name);
      }
    }
  });

  /* --------- turn_end: run dirty checks once per turn --------- */
  pi.on("turn_end", (_event, ctx) => {
    const projectRoot = ctx.cwd;
    void runChecksFor(projectRoot, ctx);
  });

  /* --------- /check: manual one-shot run --------- */
  pi.registerCommand("check", {
    description:
      "Run project typecheck/lint checks (per .pi/checks.json) now; --last shows the previous result without rerunning",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const projectRoot = ctx.cwd;
      if (!requireTrustedProject(projectRoot, ctx, true)) return;
      const cfg = loadProjectConfig(projectRoot);
      if (cfg.checks.length === 0) {
        ctx.ui.notify("No checks configured in .pi/checks.json", "info");
        return;
      }
      const raw = args.trim();
      const showLast = raw === "--last" || raw.endsWith(" --last") || raw.startsWith("--last ");
      const wanted = raw.replace(/(^|\s)--last(\s|$)/, " ").trim();
      const targets = wanted
        ? cfg.checks.filter((c) => c.name === wanted)
        : cfg.checks.filter((c) => c.enabled);
      if (wanted && targets.length === 0) {
        ctx.ui.notify(`[pi-check] unknown checker: ${wanted}`, "warning");
        return;
      }
      for (const check of targets) {
        if (showLast) {
          const cached = lastResults.get(flightKey(projectRoot, check.name));
          if (!cached) {
            ctx.ui.notify(
              `[pi-check] ${check.name}: no previous run in this session — run /check ${check.name}`,
              "info",
            );
            continue;
          }
          const age = Math.round((Date.now() - cached.at) / 1000);
          const prev = summarizeResult(check.name, cached.result);
          ctx.ui.notify(
            `[pi-check] ${check.name}: ${prev.label} (cached, ${age}s ago)`,
            prev.failed ? "error" : "info",
          );
          if (
            (prev.failed || cached.result.truncated || cached.result.timedOut) &&
            ctx.hasUI
          ) {
            await ctx.ui.editor(
              `[pi-check] ${check.name} output (cached, ${age}s ago)`,
              formatRunOutput(check.name, cached.result),
            );
          }
          continue;
        }
        const result = await runSerialized(projectRoot, check);
        if (result.configError) {
          ctx.ui.notify(`[pi-check] ${check.name}: ${result.configError}`, "error");
          continue;
        }
        const { label, failed } = summarizeResult(check.name, result);
        ctx.ui.notify(`[pi-check] ${check.name}: ${label}`, failed ? "error" : "info");
        // Manual /check never injects into the LLM context or starts a turn.
        // Failures / timeout / truncation open an editor with the bounded output.
        if ((failed || result.truncated || result.timedOut) && ctx.hasUI) {
          await ctx.ui.editor(`[pi-check] ${check.name} output`, formatRunOutput(check.name, result));
        }
      }
    },
  });

  /* --------- /simplify: review recently changed code (absorbed) --------- */
  pi.registerCommand("simplify", {
    description:
      "Review recently changed code for clarity, consistency, and maintainability improvements",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await handleSimplifyCommand(pi, ctx);
    },
  });
}
