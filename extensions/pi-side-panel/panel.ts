/**
 * panel - the /side overlay: a persistent side thread with its own input box.
 *
 * Replaces the vendored btw-ui.ts, whose overlay is one question per command and
 * has no text field: it can only be dismissed, scrolled, or cleared. This one
 * holds an `Input` so the side thread can be continued from inside the panel,
 * which is the whole point of the fork (the zcode /side shape, read-only).
 *
 * Still read-only by construction: the call goes out with `tools: []` (see
 * driver.ts), so nothing here can edit a file or run a command.
 *
 * Layout: the banner and the input/footer are pinned; the side thread scrolls
 * between them with ↑/↓.
 *   banner    - "/side" stripe with the question in flight (pinned top)
 *   transcript- every completed turn: its question, then its answer (cached)
 *   live      - the pending glyph, or the provider error (4-col gutter)
 *   input     - the follow-up field (2-col gutter, pinned bottom)
 *   footer    - key hints + the clickable close row (pinned bottom)
 *
 * Focus: the TUI marks the focused overlay component by setting `focused`.
 * `Input` implements Focusable and must receive that flag or a CJK IME's
 * candidate window lands on the wrong screen position (tui.md says so
 * explicitly), so render() mirrors `this.focused` onto the child first.
 */

import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { assistantMessageText, type BtwTurn, userMessageText } from "./vendor/btw-messages.js";

const MAX_HEIGHT_RATIO = 0.6;
/**
 * Hard row cap, independent of terminal size.
 *
 * Shrinking the panel was tried while chasing a slow panel, but the footer's own
 * readout settled it: `render 0ms` while typing still lagged 1-2s, and a shorter
 * panel did not help. That cost is in Pi Web's extension-panel layer, not in this
 * render, so the cap is back to a readable size.
 */
const MAX_ROWS_HARD = 30;
const OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: `${MAX_HEIGHT_RATIO * 100}%`,
	margin: { left: 0, right: 0, bottom: 0 },
};

const SIDE_PAD = "  "; // 2-col gutter: history, input, footer
const ANSWER_PAD = "    "; // 4-col gutter: answer body
const LITERAL = "/side";
const PENDING_GLYPH = "…";
const MSG_TRIMMED = "context trimmed to fit the window";
const MSG_READONLY = "read-only: no tools";
/** Banner + its blank line. Kept on screen while the thread scrolls. */
const HEAD_LINES = 2;

/** One completed side turn. Its answer is rendered once per width and cached. */
interface TurnView {
	question: string;
	markdown: Markdown;
	/** Index of this turn's question line inside the transcript cache. */
	lineStart: number;
}

export interface SidePanelCallbacks {
	/** A follow-up was submitted from the input box. */
	onSubmit: (question: string) => void;
	/** Esc (or the input's own escape handling) asked to close the panel. */
	onDismiss: () => void;
}

type Phase = "idle" | "pending" | "error";

export class SidePanel implements Component, Focusable {
	/** Component + Focusable: set by the TUI, mirrored onto the Input in render(). */
	focused = false;

	private readonly input: Input;
	private readonly markdownTheme = getMarkdownTheme();
	/** One rendered block per completed turn; the panel is a scrollable thread. */
	private readonly views: TurnView[] = [];
	/** Width the transcript was laid out at; 0 forces a re-layout. */
	private viewsWidth = 0;
	private transcriptCache: string[] | null = null;
	/** Which turn ↑/↓ is on; the newest by default. */
	private turnCursor = 0;
	/** Body rows visible in the last render, and the body's total length. */
	private lastRoom = 1;
	private bodyLength = 0;
	/** Duration of the last render, shown in the footer as a perf readout. */
	private renderMs = 0;
	/** Row of the close target in the lines returned by the LAST render (0-based). */
	private closeRow = -1;
	private history: BtwTurn[];
	private phase: Phase = "idle";
	private question = "";
	private errorText = "";
	private trimmed = false;
	private scrollOffset = 0;

	constructor(
		private readonly theme: Theme,
		private readonly tui: TUI,
		history: BtwTurn[],
		private readonly callbacks: SidePanelCallbacks,
	) {
		this.history = [...history];
		// Earlier turns already carry their answers; render them so a re-opened panel
		// shows the whole thread, not just the questions.
		for (const turn of history) {
			this.views.push({
				question: userMessageText(turn.userMessage),
				markdown: new Markdown(assistantMessageText(turn.assistantMessage), 0, 0, this.markdownTheme),
				lineStart: 0,
			});
		}
		this.input = new Input({
			prompt: "> ",
			placeholder: "side question - Enter to ask, Esc to close",
		});
		this.input.onSubmit = (value: string) => {
			const question = value.trim();
			if (!question) return;
			this.input.setValue("");
			this.callbacks.onSubmit(question);
		};
		this.input.onEscape = () => this.callbacks.onDismiss();
	}

	/**
	 * Take keyboard focus back for the panel's own input box.
	 *
	 * Pi returns focus to the editor when a turn settles, so without this the next
	 * keystroke goes to the main conversation instead of the side thread - and the
	 * panel looks identical either way, which is what made it confusing.
	 */
	takeFocus(): void {
		try {
			this.tui.setFocus(this);
		} catch {
			/* older TUI without overlay focus control: keys fall back to the editor */
		}
	}

	/** A turn started; the answer area shows the pending glyph. */
	beginTurn(question: string, atBottom: boolean): void {
		this.question = question;
		this.phase = "pending";
		this.errorText = "";
		this.trimmed = false;
		this.scrollOffset = atBottom ? 0 : this.scrollOffset;
		this.takeFocus();
		this.tui.requestRender();
	}

	/** A turn finished cleanly: its question and answer join the thread. */
	completeTurn(turn: BtwTurn, answer: string, trimmed: boolean): void {
		this.history.push(turn);
		this.views.push({
			question: userMessageText(turn.userMessage),
			markdown: new Markdown(answer, 0, 0, this.markdownTheme),
			lineStart: 0,
		});
		this.viewsWidth = 0; // a new block: lay the transcript out again
		this.turnCursor = this.views.length - 1;
		this.trimmed = trimmed;
		this.phase = "idle";
		this.scrollOffset = 0;
		this.takeFocus();
		this.tui.requestRender();
	}

	/** A turn failed; the provider message is shown as-is. */
	failTurn(message: string, keepQuestion: boolean): void {
		this.errorText = message;
		this.phase = "error";
		if (!keepQuestion) this.question = "";
		this.takeFocus();
		this.tui.requestRender();
	}

	/** The panel is closing; drop the in-flight question so a re-open starts clean. */
	reset(): void {
		this.question = "";
		this.phase = "idle";
		this.errorText = "";
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		// ↑/↓ switch between turns (the readable unit); PageUp/PageDown scroll lines
		// inside one; End returns to the newest. Everything else is the input, which
		// owns Enter (submit), Esc (dismiss), editing, paste, and its own undo.
		if (matchesKey(data, Key.up)) {
			this.jumpTo(this.turnCursor - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.jumpTo(this.turnCursor + 1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.jumpTo(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.jumpTo(this.views.length - 1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = this.scrollOffset + Math.max(1, this.lastRoom);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.lastRoom));
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
	}

	/** Move the turn cursor and bring that turn's question to the top of the view. */
	private jumpTo(index: number): void {
		if (this.views.length === 0) return;
		this.turnCursor = Math.max(0, Math.min(this.views.length - 1, index));
		this.viewsWidth = 0; // the selection marker is part of the cached block
		if (this.turnCursor === this.views.length - 1) {
			this.scrollOffset = 0; // newest: stay at the bottom
		} else {
			const view = this.views[this.turnCursor];
			this.scrollOffset = Math.max(0, this.bodyLength - this.lastRoom - view.lineStart);
		}
		this.tui.requestRender();
	}

	/**
	 * Mouse: a left click on the close row dismisses the panel, any other left click
	 * in the panel takes keyboard focus back for the input box (the second way back
	 * from Pi handing focus to the editor after a turn).
	 */
	handleMouse(event: TuiMouseEvent): { handled: boolean; focus?: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (this.closeRow >= 0 && event.y === this.closeRow) {
			this.callbacks.onDismiss();
			return { handled: true };
		}
		return { handled: true, focus: true };
	}

	invalidate(): void {
		// render() recomputes from state every cycle. The Input is invalidated (one
		// line, and a resize must re-lay it out), but the transcript deliberately is
		// NOT: markdown re-parsing is the expensive part of a repaint and the cached
		// lines are rebuilt only when a turn lands or the width changes.
		this.input.invalidate();
	}

	render(width: number): string[] {
		const startedAt = Date.now();
		const theme = this.theme;
		// The whole side thread, newest last. This used to render only the questions
		// and keep a single answer, so earlier replies were unreachable.
		const transcriptLines = this.transcript(width);

		// The child needs the focus flag before it renders: it owns the hardware
		// cursor position (CURSOR_MARKER) that an IME candidate window follows.
		this.input.focused = this.focused;
		const inputLines = this.input.render(Math.max(1, width - SIDE_PAD.length)).map((line) => SIDE_PAD + line);

		const answerLines = this.renderAnswer(width);
		const closeLine = this.renderCloseRow(width);
		const natural: string[] = [
			this.renderBanner(width),
			"",
			...transcriptLines,
			...answerLines,
			"",
			...inputLines,
			this.notice(MSG_READONLY, "dim", width),
			...(this.trimmed ? [this.notice(MSG_TRIMMED, "warning", width)] : []),
			closeLine,
			this.renderFooter(width),
		];
		// Pinned bottom starts at the first input line; the close row sits in it.
		// Pinned bottom: the input, the read-only note, any trimmed note, the close
		// row and the hint line. Everything before that scrolls.
		const tailStart = natural.length - 3 - (this.trimmed ? 1 : 0) - inputLines.length;
		const closeIndex = natural.length - 2;

		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(6, Math.min(Math.floor(termRows * MAX_HEIGHT_RATIO), MAX_ROWS_HARD));
		if (natural.length <= maxRows) {
			this.closeRow = closeIndex;
			this.renderMs = Date.now() - startedAt;
			return natural;
		}

		// Scroll only the thread: the banner stays at the top and the input, notes,
		// close row and hints stay at the bottom, so the field is always reachable.
		const tail = natural.slice(tailStart);
		const body = natural.slice(HEAD_LINES, tailStart);
		const room = Math.max(1, maxRows - HEAD_LINES - tail.length);
		const maxOffset = Math.max(0, body.length - room);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const start = Math.max(0, body.length - room - this.scrollOffset);
		const visible = body.slice(start, start + room);
		this.closeRow = HEAD_LINES + visible.length + (closeIndex - tailStart);
		this.lastRoom = room;
		this.bodyLength = body.length;
		this.renderMs = Date.now() - startedAt;
		return [...natural.slice(0, HEAD_LINES), ...visible, ...tail];
	}

	private renderBanner(width: number): string {
		const prefix = `${SIDE_PAD}${LITERAL} `;
		const available = Math.max(0, width - visibleWidth(prefix));
		const text = this.question ? truncateToWidth(this.question, available, "…", false) : "";
		const raw = prefix + text;
		const padded = raw + " ".repeat(Math.max(0, width - visibleWidth(raw)));
		return this.theme.bg("customMessageBg", this.theme.fg("customMessageText", padded));
	}

	private entryLine(question: string, width: number, selected: boolean): string {
		const available = Math.max(0, width - SIDE_PAD.length);
		const clean = question.replace(/\s+/g, " ").trim();
		const text = `${selected ? "▸" : " "} ${LITERAL} ${clean}`;
		return SIDE_PAD + this.theme.fg(selected ? "accent" : "muted", truncateToWidth(text, available, "…", false));
	}

	private notice(text: string, color: "warning" | "dim", width: number): string {
		const available = Math.max(1, width - ANSWER_PAD.length);
		return ANSWER_PAD + truncateToWidth(this.theme.fg(color, text), available, "…", false);
	}

	/**
	 * The rendered side thread, newest last, cached per width.
	 *
	 * Each turn's markdown is rendered ONCE per width: re-parsing an answer and
	 * syntax-highlighting its code blocks on every keystroke is what made typing in
	 * this panel feel like broken input. The cache is rebuilt only when a turn lands
	 * (`viewsWidth = 0`) or the terminal width changes.
	 */
	private transcript(width: number): string[] {
		if (this.transcriptCache !== null && this.viewsWidth === width) return this.transcriptCache;
		const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
		const lines: string[] = [];
		for (const view of this.views) {
			view.lineStart = lines.length;
			lines.push(this.entryLine(view.question, width, view === this.views[this.turnCursor]));
			lines.push(...view.markdown.render(bodyWidth).map((line) => ANSWER_PAD + line));
			lines.push("");
		}
		this.viewsWidth = width;
		this.transcriptCache = lines;
		return lines;
	}

	private renderAnswer(width: number): string[] {
		const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
		if (this.phase === "pending") {
			return [ANSWER_PAD + this.theme.fg("warning", PENDING_GLYPH)];
		}
		if (this.phase === "error") {
			// Provider text is not markdown: wrap it literally in the error color.
			const lines: string[] = [];
			for (const raw of this.errorText.split("\n")) {
				lines.push(...wrapTextWithAnsi(this.theme.fg("error", raw.length === 0 ? " " : raw), bodyWidth));
			}
			return lines.map((line) => ANSWER_PAD + line);
		}
		// Answers live in the transcript (completeTurn caches them there).
		return [];
	}

	/** The click target. Labelled so the affordance is visible, not just wired. */
	private renderCloseRow(width: number): string {
		const available = Math.max(1, width - SIDE_PAD.length);
		return SIDE_PAD + truncateToWidth(this.theme.fg("dim", "[ x close ]"), available, "…", false);
	}

	private renderFooter(width: number): string {
		const hints = ["↑/↓ turn", "PgUp/PgDn scroll", "Esc close", `render ${this.renderMs}ms`];
		const available = Math.max(1, width - SIDE_PAD.length);
		return SIDE_PAD + truncateToWidth(this.theme.fg("dim", hints.join(" · ")), available, "…", false);
	}
}

export interface ShowSidePanelParams {
	ctx: ExtensionCommandContext;
	history: BtwTurn[];
	/** A follow-up was submitted from the input box. */
	onSubmit: (question: string) => void;
	/** The panel is closing (Esc); the driver aborts any in-flight call here. */
	onDismiss?: () => void;
}

export interface ShowSidePanelResult {
	overlayPromise: Promise<void>;
	panelReady: Promise<SidePanel>;
}

/**
 * Open the persistent side panel. `ctx.ui.custom` owns the component's lifetime:
 * it resolves when the injection-supplied `done()` runs, which happens only on
 * Esc/dismiss, so one component serves every follow-up turn (the panel is one
 * interaction, not one question).
 */
export function showSidePanel(params: ShowSidePanelParams): ShowSidePanelResult {
	let resolveReady!: (panel: SidePanel) => void;
	const panelReady = new Promise<SidePanel>((resolve) => {
		resolveReady = resolve;
	});

	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const panel = new SidePanel(theme, tui, params.history, {
				onSubmit: params.onSubmit,
				onDismiss: () => {
					params.onDismiss?.();
					done();
				},
			});
			resolveReady(panel);
			return panel;
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);

	return { overlayPromise, panelReady };
}
