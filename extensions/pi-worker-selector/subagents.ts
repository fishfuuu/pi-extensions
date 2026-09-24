/**
 * pi-worker-selector → pi-subagents delegation adapter.
 *
 * Selects a worker model with the existing selector policy, then asks pi-subagents
 * to run one configured foreground leaf agent with that exact model through its
 * public structured delegation API.
 *
 * Scope: only delegations started through this adapter pass through the selector.
 * A direct native `subagent` call is untouched and keeps pi-subagents' own model
 * resolution. pi-subagents stays responsible for agent discovery, prompt/system
 * role, tools/MCP, fresh/fork, the child session, background/runtime, usage and
 * the resume/steer/stop lifecycle.
 *
 * No dependency on pi-subagents: the two event names are mirrored from its
 * documented public contract (`pi-subagents/delegation`, "Structured delegation
 * API") and every emitted payload is validated by pi-subagents' own request
 * parser, which rejects unsupported fields. `tests/subagents.test.mjs` asserts the
 * mirrored names equal the installed package's exported constants when it is
 * installed. This package deliberately adds no pi-subagents dependency.
 */
import { selectWorkerModel, stripThinkingSuffix, type PoolEntry, type WorkerMode } from "./core.ts";
import type { QuotaSnapshot } from "../pi-quota/snapshot.ts";

/** Mirrors `SUBAGENT_DELEGATION_REQUEST_EVENT` in `pi-subagents/delegation`. */
export const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
/** Mirrors `SUBAGENT_DELEGATION_RESPONSE_EVENT` in `pi-subagents/delegation`. */
export const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";

/** Mirrors `SubagentDelegationThinking`. */
export type DelegationThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Everything pi-subagents owns about the launch. The selector never rewrites these. */
export interface DelegationSpec {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  thinking?: DelegationThinking;
  /** Child execution deadline, forwarded to pi-subagents unchanged. */
  timeoutMs?: number;
}

/** The payload this adapter emits. `model` is the only field the selector decides. */
export interface SubagentDelegationRequestPayload extends DelegationSpec {
  model: string;
  result: { kind: "text" };
}

/** The terminal-response fields this adapter reads. pi-subagents owns the full contract. */
export interface SubagentDelegationResponsePayload {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: string;
  model?: string;
  error?: string;
}

/** The subset of `pi.events` this adapter needs; the real event bus satisfies it. */
export interface DelegationTransport {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
}

export interface DelegateSelectedSubagentInput {
  mode: WorkerMode;
  pool: PoolEntry[];
  quotaSnapshots: Map<string, QuotaSnapshot>;
  availableModels: string[];
  spec: DelegationSpec;
  /** How long to wait for the terminal response. Not a child deadline. */
  responseTimeoutMs?: number;
}

export type DelegationOutcome =
  | { outcome: "STOP"; reason: string; affectedProvider?: string }
  | { outcome: "DELEGATED"; model: string; response: SubagentDelegationResponsePayload }
  | {
      outcome: "MODEL_MISMATCH";
      selectedModel: string;
      actualModel: string;
      response: SubagentDelegationResponsePayload;
    }
  | { outcome: "NO_TERMINAL_RESPONSE"; model: string; reason: string };

export const DEFAULT_RESPONSE_TIMEOUT_MS = 600_000;

/**
 * Build the exact payload pi-subagents will receive for a resolved model. Pure.
 *
 * `model` is passed explicitly: pi-subagents resolves an explicit model against
 * its own registry and fails hard (`Unknown subagent model ...`) instead of
 * substituting another provider.
 */
export function buildDelegationRequest(
  selectedModel: string,
  spec: DelegationSpec,
): SubagentDelegationRequestPayload {
  return { ...spec, model: selectedModel, result: { kind: "text" } };
}

/**
 * Select a worker model, then delegate one foreground leaf run to pi-subagents
 * with that model.
 *
 * A selector STOP emits no request and spawns no child. A terminal response whose
 * model differs from the selection is reported as MODEL_MISMATCH rather than
 * accepted silently; a thinking suffix or case difference is not a mismatch.
 */
export async function delegateSelectedSubagent(
  transport: DelegationTransport,
  input: DelegateSelectedSubagentInput,
): Promise<DelegationOutcome> {
  const selection = selectWorkerModel({
    mode: input.mode,
    pool: input.pool,
    quotaSnapshots: input.quotaSnapshots,
    availableModels: input.availableModels,
  });

  if (selection.outcome === "STOP") {
    return {
      outcome: "STOP",
      reason: selection.reason,
      ...(selection.affectedProvider ? { affectedProvider: selection.affectedProvider } : {}),
    };
  }

  const request = buildDelegationRequest(selection.model, input.spec);
  const responseTimeoutMs = input.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const response = await awaitTerminalResponse(transport, request, responseTimeoutMs);

  if (!response) {
    return {
      outcome: "NO_TERMINAL_RESPONSE",
      model: selection.model,
      reason: `no terminal delegation response within ${responseTimeoutMs}ms`,
    };
  }

  if (typeof response.model === "string" && !sameModelSpec(response.model, selection.model)) {
    return {
      outcome: "MODEL_MISMATCH",
      selectedModel: selection.model,
      actualModel: response.model,
      response,
    };
  }

  return { outcome: "DELEGATED", model: selection.model, response };
}

/**
 * Same model, ignoring a thinking suffix and case — the comparison resolve.ts uses
 * for DW decisions. pi-subagents is allowed to canonicalize the id it was given.
 */
function sameModelSpec(a: string, b: string): boolean {
  return stripThinkingSuffix(a).toLowerCase() === stripThinkingSuffix(b).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalResponseFor(
  payload: unknown,
  request: SubagentDelegationRequestPayload,
): payload is SubagentDelegationResponsePayload & Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.status !== "string") return false;
  return (
    payload.requestId === request.requestId &&
    payload.ownerRunId === request.ownerRunId &&
    payload.nodeId === request.nodeId
  );
}

function awaitTerminalResponse(
  transport: DelegationTransport,
  request: SubagentDelegationRequestPayload,
  timeoutMs: number,
): Promise<SubagentDelegationResponsePayload | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (value: SubagentDelegationResponsePayload | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
      resolve(value);
    };

    const maybeUnsubscribe = transport.on(DELEGATION_RESPONSE_EVENT, (payload) => {
      if (!isTerminalResponseFor(payload, request)) return;
      finish(payload);
    });
    if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;

    timer = setTimeout(() => finish(undefined), timeoutMs);
    transport.emit(DELEGATION_REQUEST_EVENT, request);
  });
}
