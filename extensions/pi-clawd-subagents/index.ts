/**
 * pi-clawd-subagents - make headless (print/json) pi processes visible in the
 * Clawd on Desk session HUD.
 *
 * Clawd on Desk ships a first-party pi extension at
 * ~/.pi/agent/extensions/clawd-on-desk/. It posts session state to
 * http://127.0.0.1:23333/state with `agent_id: "pi"`, `hook_source:
 * "pi-extension"` and a `pi:<sessionId>` session key.
 *
 * That extension gates on `ctx.hasUI`, which pi reports as true in TUI and RPC
 * modes but false in print/json modes. So `pi -p` and `pi --mode json`
 * processes never reach the pet, even though they are ordinary running pi
 * processes: a delegated investigation, a background job, a workflow worker.
 *
 * This extension covers exactly that gap and nothing else:
 *   - reports ONLY in print/json modes, so it can never double-report a TUI or
 *     RPC session the vendor extension already owns;
 *   - reports ONLY when PI_CLAWD_SUBAGENTS is truthy (opt-in, so stray one-shot
 *     runs do not turn into HUD entries);
 *   - exports PI_CLAWD_SUBAGENTS=1 from any loaded session, so processes spawned
 *     later by tools (bash, background tasks, workflows) inherit the opt-in;
 *   - reuses the vendor's payload shape, so the app treats these sessions like
 *     any other pi session.
 *
 * Two payload fields are deliberately omitted:
 *   - `headless`: the app filters headless sessions out of the session HUD
 *     (`isHudSession()` requires `!session.headless`), which is the opposite of
 *     the goal here;
 *   - `subagentId` / `subagentType`: real app fields, but their semantics are
 *     not documented and they are not needed for visibility.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_ID = "pi";
const HOOK_SOURCE = "pi-extension";
const SERVER_ID = "clawd-on-desk";
const SERVER_HEADER = "x-clawd-server";
const STATE_PATH = "/state";
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");

/**
 * The vendor extension uses 150ms, which drops updates when the app is busy.
 * Refused connections still fail immediately, so a generous timeout only costs
 * time on a port that accepts and then stalls.
 */
const HTTP_TIMEOUT_MS = 800;

export const ENABLE_ENV = "PI_CLAWD_SUBAGENTS";

type PiMode = "interactive" | "print" | "json" | "rpc";

function parseMode(args: readonly string[] = process.argv.slice(2)): PiMode {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") return "print";
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
    if (typeof arg === "string" && arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
  }
  return "interactive";
}

function isPrintMode(): boolean {
  const mode = parseMode();
  return mode === "print" || mode === "json";
}

function isEnabled(): boolean {
  const raw = String(process.env[ENABLE_ENV] ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no";
}

/**
 * A loaded session marks its own descendants. Children spawned later by tools
 * inherit this process env, so `pi -p` runs started from a pi session report
 * without any wiring in the spawner. An explicit `PI_CLAWD_SUBAGENTS=0` is
 * respected and never overwritten.
 */
function exportEnableFlag(): void {
  if (process.env[ENABLE_ENV] === undefined) process.env[ENABLE_ENV] = "1";
}

function readRuntimePort(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8")) as { port?: unknown };
    const port = Number(raw?.port);
    return Number.isInteger(port) && SERVER_PORTS.includes(port) ? port : null;
  } catch {
    return null;
  }
}

function getPorts(): number[] {
  const ports: number[] = [];
  const add = (port: number | null) => {
    if (port && !ports.includes(port)) ports.push(port);
  };
  add(readRuntimePort());
  for (const port of SERVER_PORTS) add(port);
  return ports;
}

function isClawdResponse(res: http.IncomingMessage, body: string): boolean {
  const header = res.headers[SERVER_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === SERVER_ID) return true;
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as { app?: unknown };
    return parsed?.app === SERVER_ID;
  } catch {
    return false;
  }
}

function postToPort(port: number, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: STATE_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 256) text += chunk;
        });
        res.on("end", () => resolve(isClawdResponse(res, text)));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

async function postState(payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify(payload);
  for (const port of getPorts()) {
    if (await postToPort(port, body)) return true;
  }
  return false;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function readSessionId(ctx: ExtensionContext): string {
  const manager = (ctx as unknown as { sessionManager?: Record<string, unknown> }).sessionManager;
  const candidates = [
    safeCall(() => (manager?.getSessionId as (() => unknown) | undefined)?.call(manager)),
    safeCall(() => (manager?.getSessionFile as (() => unknown) | undefined)?.call(manager)),
    process.env.PI_SESSION_ID,
  ];
  for (const candidate of candidates) {
    const value = safeString(candidate);
    if (value) return value;
  }
  return "default";
}

function buildPayload(
  state: string,
  event: string,
  nativeEvent: ExtensionEvent | undefined,
  ctx: ExtensionContext,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    event,
    state,
    session_id: `${AGENT_ID}:${readSessionId(ctx)}`,
    agent_pid: process.pid,
    cwd: safeString((ctx as unknown as { cwd?: unknown }).cwd) || process.cwd(),
  };
  const toolName = safeString((nativeEvent as { toolName?: unknown } | undefined)?.toolName);
  const toolCallId = safeString((nativeEvent as { toolCallId?: unknown } | undefined)?.toolCallId);
  if (toolName) payload.tool_name = toolName;
  if (toolCallId) payload.tool_use_id = toolCallId;
  return payload;
}

export default function piClawdSubagents(pi: ExtensionAPI): void {
  // Runs in every session, including the interactive ones this extension stays
  // silent for: the flag it exports is what makes their children report.
  exportEnableFlag();

  if (!isPrintMode() || !isEnabled()) return;

  let chain: Promise<unknown> = Promise.resolve();

  function send(
    state: string,
    event: string,
    nativeEvent: ExtensionEvent | undefined,
    ctx: ExtensionContext,
    waitForDelivery = false,
  ): void {
    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(state, event, nativeEvent, ctx);
    } catch {
      return;
    }
    const deliver = () => Promise.resolve(postState(payload)).catch(() => false);
    if (!waitForDelivery) {
      void deliver();
      return;
    }
    // Keep ordering: an error state must land before the turn-ending event.
    chain = chain.then(deliver, deliver);
  }

  pi.on("session_start", (nativeEvent, ctx) => send("idle", "SessionStart", nativeEvent, ctx));
  pi.on("before_agent_start", (nativeEvent, ctx) => send("thinking", "UserPromptSubmit", nativeEvent, ctx));
  pi.on("tool_call", (nativeEvent, ctx) => send("working", "PreToolUse", nativeEvent, ctx));
  pi.on("tool_result", (nativeEvent, ctx) => {
    const isError = Boolean((nativeEvent as { isError?: unknown } | undefined)?.isError);
    send(
      isError ? "error" : "working",
      isError ? "PostToolUseFailure" : "PostToolUse",
      nativeEvent,
      ctx,
      isError,
    );
  });
  pi.on("session_before_compact", (nativeEvent, ctx) => send("sweeping", "PreCompact", nativeEvent, ctx));
  pi.on("session_compact", (nativeEvent, ctx) => send("attention", "PostCompact", nativeEvent, ctx));
  pi.on("agent_end", (nativeEvent, ctx) => send("attention", "Stop", nativeEvent, ctx, true));
  pi.on("session_shutdown", (nativeEvent, ctx) => send("sleeping", "SessionEnd", nativeEvent, ctx, true));
}
