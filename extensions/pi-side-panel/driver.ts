/**
 * driver - `/side`: a read-only side thread you keep chatting in, in a panel.
 *
 * Why this file exists rather than calling the vendored `executeBtw()`:
 *
 *  1. THE LOOP. Upstream runs one question per command and closes the overlay.
 *     Here the panel stays open and every submit runs another turn, so this is
 *     the orchestration upstream keeps inside `executeBtw`, rewritten to be
 *     called repeatedly and to report back into the panel.
 *
 *  2. THE BRANCH BUDGET IS AN ESTIMATE, AND A BAD ONE FOR CJK. Upstream bounds
 *     the branch with the host's `estimateTokens`, which is `chars / 4`; Chinese
 *     runs close to one token per character, so a mostly-Chinese session is
 *     undercounted and the assembled prompt can exceed the window the provider
 *     enforces (upstream issue juicesharp/rpiv-mono#274). `buildBtwMessages`
 *     accepts an explicit `keepBudget` that bypasses its own window formula, so
 *     we measure the branch ourselves and hand it a budget expressed in its
 *     units. No vendored file is edited for this.
 *
 *  3. CONTEXT OVERFLOW IS NOT RECOGNIZED ON Z.AI'S CN ENDPOINT. The retry below
 *     is upstream's (halve the budget, re-send once), but its trigger is Pi's
 *     `isContextOverflow`, whose OVERFLOW_PATTERNS match api.z.ai's
 *     "Prompt too long" and not open.bigmodel.cn's "Prompt exceeds max length".
 *     Without the extra pattern the retry never fires there and the raw
 *     400 {"code":"1261"} reaches the panel (pi issue #10208). No vendored file
 *     is edited for this either.
 *
 * Read-only by construction: the request goes out with `tools: []`, the system
 * prompt forbids tool use, and the answer is rendered in an overlay - it never
 * becomes a transcript entry and nothing is written to disk. History lives in
 * the same process-scoped state the upstream /btw uses, so the two commands
 * share one side thread per session.
 */

import type { AssistantMessage, StopReason, UserMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionAPI, type ExtensionCommandContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BTW_CONTEXT_RESERVE,
	BTW_STATE_KEY,
	type BtwBuiltContext,
	type BtwTurn,
	buildBtwMessages,
	branchToMessages,
} from "./vendor/btw.js";
import { getRuntimeCompleteSimple, loadCompleteSimple, loadIsContextOverflow } from "./vendor/pi-compat.js";
import { showSidePanel, type SidePanel } from "./panel.js";

export const SIDE_COMMAND_NAME = "side";

const MSG_REQUIRES_INTERACTIVE = "/side requires interactive mode";
const MSG_NO_MODEL = "/side requires an active model";
const MSG_ANSWER_EMPTY = "/side got an empty answer";
const MSG_BUSY = "A side question is already running";
const MSG_WINDOW_TOO_SMALL = "/side cannot fit this model's window (context window is smaller than its output budget plus reserve)";

/** Pi's isContextOverflow matches api.z.ai's wording; the CN endpoint says this. */
const EXTRA_OVERFLOW_WORDINGS = [/prompt exceeds max length/i];

/**
 * The overflow wordings this gate can match on its own.
 *
 * Pi's `isContextOverflow` is the authority, but `pi-compat` returns undefined
 * when the host's `/compat` entrypoint cannot be resolved, and then a gate that
 * only knows the one extra wording above stays silent for everything else. This
 * happened for real: Ollama Cloud answered `The prompt is too long: 1204597,
 * model maximum context length: 1048576`, which Pi's own
 * `/prompt (?:is )?too long/i` matches, so no retry ran and the raw 400 reached
 * the panel. These mirror Pi's core patterns (pi 0.87.1) plus the CN wording.
 */
const FALLBACK_OVERFLOW_WORDINGS = [
	/prompt (?:is )?too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length/i,
	/maximum context length/i,
	/context length is only/i,
	...EXTRA_OVERFLOW_WORDINGS,
];

/** Pi's NON_OVERFLOW_PATTERNS: rate limiting and outages are not overflow. */
const NON_OVERFLOW_WORDINGS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

// ---------------------------------------------------------------------------
// Shared process-scoped state (the upstream /btw state, keyed by the same
// exported symbol). Sharing it is deliberate: it is how one side thread per
// session survives across both commands, and it is why buildBtwMessages sees
// the turns pushed below.
// ---------------------------------------------------------------------------

interface SideState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, unknown>;
}

function getSharedState(): SideState {
	const holder = globalThis as unknown as { [key: symbol]: SideState | undefined };
	let state = holder[BTW_STATE_KEY];
	if (!state || !(state.histories instanceof Map)) {
		state = { histories: new Map(), snapshots: new Map() };
		holder[BTW_STATE_KEY] = state;
	}
	return state;
}

function sessionKey(ctx: ExtensionCommandContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

/**
 * Hand the shared side thread the same context Pi itself sends to the model.
 *
 * Upstream snapshots the WHOLE branch (`ctx.sessionManager.getBranch()`), so on a
 * long session that has been compacted many times the side call clones every
 * pre-compaction message. On the session this was found in, the compacted context
 * was ~9% of a 1048576 window while the raw branch was 1204597 tokens: every
 * /side question was rejected as too long even though the question was trivial.
 * `buildContextEntries()` is the view Pi actually sends - the newest compaction
 * summary plus the entries after it - and `branchToMessages` (upstream's own
 * exported helper) turns it into the LLM messages `buildBtwMessages` expects.
 *
 * Written on every turn because upstream's `message_end` hook rewrites this
 * snapshot with the full branch as soon as the next message lands.
 */
function refreshSideSnapshot(ctx: ExtensionCommandContext): void {
	let entries: SessionEntry[];
	try {
		entries = ctx.sessionManager.buildContextEntries();
	} catch {
		return; // unexpected session shape: keep whatever upstream snapshotted
	}
	try {
		getSharedState().snapshots.set(sessionKey(ctx), {
			messages: branchToMessages(entries),
			entries,
		});
	} catch {
		/* best effort - upstream falls back to its own live branch read */
	}
}

function getSessionHistory(state: SideState, ctx: ExtensionCommandContext): BtwTurn[] {
	const key = sessionKey(ctx);
	let turns = state.histories.get(key);
	if (!turns) {
		turns = [];
		state.histories.set(key, turns);
	}
	return turns;
}

// ---------------------------------------------------------------------------
// CJK-aware sizing
// ---------------------------------------------------------------------------

/** Ranges that tokenize near one token per character, unlike Latin text. */
function isWideChar(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x2eff) || // CJK radicals
		(codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK punctuation
		(codePoint >= 0x3040 && codePoint <= 0x30ff) || // Kana
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK ext A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified
		(codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat
		(codePoint >= 0xff00 && codePoint <= 0xffef) // Fullwidth forms
	);
}

/** Tokens a string plausibly costs: wide characters one each, the rest at 1/4. */
function estimateRealTokens(text: string): number {
	let wide = 0;
	let rest = 0;
	for (const char of text) {
		if (isWideChar(char.codePointAt(0) ?? 0)) wide += 1;
		else rest += 1;
	}
	return wide + Math.ceil(rest / 4);
}

/**
 * Every byte a message carries, not just its text blocks.
 *
 * Sizing off text blocks alone was a real bug here: tool calls and tool results
 * are not `text` blocks, so the branch's dominant cost went uncounted, the
 * `estimateUnits` figure came out far below what buildBtwMessages actually
 * measures, and the "it already fits" early return fired on a branch that did
 * not fit (a 1.2M-token prompt against a 1,048,576 window). Serializing the
 * content keeps the two figures in the same order of magnitude.
 */
function rawTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	try {
		return JSON.stringify(content ?? "") ?? "";
	} catch {
		return "";
	}
}

/**
 * A keepBudget for buildBtwMessages, expressed in the units its estimator uses.
 *
 * Upstream trims the branch against `chars / 4`. For CJK content that figure is
 * below the real token count, so a branch it considers to fit can overflow the
 * provider. Measuring both lets us scale the budget by the ratio the content
 * actually has: an all-Chinese branch ends up admitted at roughly the real
 * windowBudget instead of up to four times it.
 *
 * Returns undefined to leave upstream's own window formula in charge (correct
 * for Latin-heavy branches), and 0 when the window is too small to reserve the
 * model's output at all.
 */
function cjkSafeKeepBudget(ctx: ExtensionCommandContext, model: { contextWindow?: number; maxTokens?: number }): number | undefined {
	const window = model.contextWindow ?? 0;
	const maxOutput = model.maxTokens ?? 0;
	if (!window || !maxOutput) return undefined;

	const windowBudget = window - maxOutput - BTW_CONTEXT_RESERVE;
	if (windowBudget <= 0) return 0;

	let messages;
	try {
		messages = branchToMessages(ctx.sessionManager.getBranch());
	} catch {
		return undefined; // unexpected branch shape: fall back to upstream's formula
	}

	// `estimateUnits` must be the SAME measure buildBtwMessages trims against
	// (the host's estimateTokens over each message), or the ratio below compares
	// two different scales and corrects nothing.
	let real = 0;
	let estimateUnits = 0;
	for (const message of messages) {
		const raw = rawTextOf(message as { content?: unknown });
		real += estimateRealTokens(raw);
		try {
			estimateUnits += estimateTokens(message);
		} catch {
			estimateUnits += Math.ceil(raw.length / 4);
		}
	}

	// Leave a small margin for the system prompt, the question, the side history
	// and rounding, none of which the branch budget below accounts for.
	const safeBudget = Math.max(0, windowBudget - 4096);
	if (real <= safeBudget && estimateUnits <= safeBudget) return undefined;

	// ratio <= 1 whenever the content is wide-character heavy.
	const ratio = real > 0 ? Math.min(1, estimateUnits / real) : 1;
	return Math.max(0, Math.floor(safeBudget * ratio));
}

// ---------------------------------------------------------------------------
// One side call
// ---------------------------------------------------------------------------

type SideCallResult =
	| { kind: "success"; userMessage: UserMessage; assistantMessage: AssistantMessage; answer: string; trimmed: boolean }
	| { kind: "error"; error: string }
	| { kind: "aborted" };

/** Upstream's predicate plus the CN endpoint's wording (pi#10208). */
async function loadOverflowPredicate(): Promise<(message: AssistantMessage, contextWindow?: number) => boolean> {
	const upstream = await loadIsContextOverflow();
	return (message, contextWindow) => {
		if (upstream) {
			try {
				if (upstream(message, contextWindow)) return true;
			} catch {
				/* fall through to the inlined patterns */
			}
		}
		if (message.stopReason !== "error") return false;
		const text = message.errorMessage ?? "";
		if (!text) return false;
		if (NON_OVERFLOW_WORDINGS.some((pattern) => pattern.test(text))) return false;
		return FALLBACK_OVERFLOW_WORDINGS.some((pattern) => pattern.test(text));
	};
}

function answerTextOf(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content ?? []) {
		const record = block as { type?: string; text?: string };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n").trim();
}

async function runSideCall(
	ctx: ExtensionCommandContext,
	question: string,
	controller: AbortController,
): Promise<SideCallResult> {
	const model = ctx.model;
	if (!model) return { kind: "error", error: MSG_NO_MODEL };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { kind: "error", error: `/side credentials unavailable for ${model.provider}:${model.id}: ${auth.error}` };
	}

	// OAuth-backed providers resolve without a literal apiKey; their credentials
	// are applied inside Pi's runtime facade, so only a legacy host needs a key.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	if (!auth.apiKey && !runtimeCompleteSimple) {
		return { kind: "error", error: `/side has no API key for ${model.provider}:${model.id}` };
	}

	// Clone the compacted context, not the whole branch: see refreshSideSnapshot.
	refreshSideSnapshot(ctx);

	const keepBudget = cjkSafeKeepBudget(ctx, model);
	if (keepBudget === 0) return { kind: "error", error: MSG_WINDOW_TOO_SMALL };

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};

	let built: BtwBuiltContext;
	try {
		built = buildBtwMessages(ctx, userMessage, keepBudget);
	} catch (error) {
		return { kind: "error", error: `/side could not assemble the side context: ${describe(error)}` };
	}

	try {
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const requestOptions = runtimeCompleteSimple
			? { signal: controller.signal }
			: { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal };
		const isOverflow = await loadOverflowPredicate();
		let retried = false;

		// tools: [] always - a side question cannot edit a file or run a command.
		const call = (context: BtwBuiltContext): Promise<AssistantMessage> =>
			completeSimple(model, { systemPrompt: context.systemPrompt, messages: context.messages, tools: [] }, requestOptions);

		let response = await call(built);
		if (response.stopReason === "aborted") return { kind: "aborted" };

		// One retry, with the budget halved - upstream's overflow gate, now able to
		// see the CN endpoint's wording.
		if (!retried && isOverflow(response, model.contextWindow)) {
			retried = true;
			built = buildBtwMessages(ctx, userMessage, Math.floor((built.keepBudget ?? 0) / 2));
			response = await call(built);
			if (response.stopReason === "aborted") return { kind: "aborted" };
		}

		if (response.stopReason === "error") {
			return { kind: "error", error: `/side call failed: ${response.errorMessage ?? "unknown error"}` };
		}

		const answer = answerTextOf(response);
		if (!answer) return { kind: "error", error: MSG_ANSWER_EMPTY };

		return {
			kind: "success",
			userMessage,
			assistantMessage: response,
			answer,
			trimmed: Boolean(built.branchWasTrimmed || built.stubbed || built.droppedTurns > 0),
		};
	} catch (error) {
		if (controller.signal.aborted) return { kind: "aborted" };
		return { kind: "error", error: `/side call failed: ${describe(error)}` };
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerSideCommand(pi: ExtensionAPI): void {
	pi.registerCommand(SIDE_COMMAND_NAME, {
		description: "Side thread in a panel: read-only, no tools, never in the transcript",
		handler: (args: string, ctx: ExtensionCommandContext) => handleSideCommand(args, ctx),
	});
}

async function handleSideCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify(MSG_NO_MODEL, "error");
		return;
	}

	const state = getSharedState();
	const history = getSessionHistory(state, ctx);
	let inFlight: AbortController | undefined;
	let closed = false;

	const runTurn = async (panel: SidePanel, question: string): Promise<void> => {
		if (closed) return;
		if (inFlight) {
			ctx.ui.notify(MSG_BUSY, "warning");
			return;
		}
		const controller = new AbortController();
		inFlight = controller;
		panel.beginTurn(question, true);

		const result = await runSideCall(ctx, question, controller);
		inFlight = undefined;
		if (closed) return;

		if (result.kind === "success") {
			// Push into the shared side thread so the next turn (and /btw) sees it.
			history.push({ userMessage: result.userMessage, assistantMessage: result.assistantMessage });
			panel.completeTurn({ userMessage: result.userMessage, assistantMessage: result.assistantMessage }, result.answer, result.trimmed);
			return;
		}
		if (result.kind === "aborted") {
			panel.reset();
			return;
		}
		panel.failTurn(result.error, false);
	};

	const { panelReady, overlayPromise } = showSidePanel({
		ctx,
		history: [...history],
		onSubmit: (question: string) => {
			void panelReady.then((panel) => runTurn(panel, question));
		},
		onDismiss: () => {
			closed = true;
			inFlight?.abort();
		},
	});

	// The overlay exists now; take the keyboard for the input box before anything
	// else, so the first thing the user types lands in the panel.
	void panelReady.then((panel) => panel.takeFocus());

	// `/side <question>` asks once right away; `/side` alone just opens the field.
	const first = args.trim();
	if (first) {
		const panel = await panelReady;
		await runTurn(panel, first);
	}

	await overlayPromise;
}
