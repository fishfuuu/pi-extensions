/**
 * pi-bash-guard — confirm dangerous bash commands before they run.
 *
 * CANARY: opt-in only. This extension is deliberately NOT part of the package
 * manifest yet; it is installed by local path while false positives/negatives
 * are evaluated. See README.md.
 *
 * Behavior:
 *  - every bash tool call is matched against the conservative rule set in core.ts
 *  - a match opens a confirmation dialog; the command runs only on explicit approval
 *  - no dialog-capable UI (ctx.hasUI === false), a dismissed dialog, a timeout, or a
 *    dialog error all FAIL CLOSED (the command is blocked)
 *  - every match is appended to an audit log so the canary can be reviewed;
 *    the log stores a command fingerprint (SHA-256 prefix + length), never the
 *    command text, because commands can contain secrets
 *
 * This is a guardrail, not a security boundary: it forces a human decision for
 * common destructive patterns and does not claim to catch obfuscated commands.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchDanger } from "./core.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LOG_PATH = join(AGENT_DIR, "pi-bash-guard.log");
const DEFAULT_TIMEOUT_MS = 120_000;

type Outcome = "approved" | "denied" | "no-ui" | "error";

function approvalTimeoutMs(): number {
	const raw = Number(process.env.PI_BASH_GUARD_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function audit(entry: Record<string, unknown>): void {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		// Logging must never break the guard or the agent run.
	}
}

/**
 * Audit entries never store the command text: commands can carry tokens,
 * connection strings and other secrets. A truncated SHA-256 plus the length
 * keeps entries correlatable with the session transcript without exposing
 * content.
 */
function commandFingerprint(command: string): { commandSha256: string; commandLength: number } {
	return {
		commandSha256: createHash("sha256").update(command).digest("hex").slice(0, 16),
		commandLength: command.length,
	};
}

async function requestApproval(
	ctx: ExtensionContext,
	why: string,
	command: string,
): Promise<{ outcome: Outcome; elapsedMs: number; dialogError?: string }> {
	const startedAt = Date.now();
	if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
		return { outcome: "no-ui", elapsedMs: 0 };
	}
	try {
		const approved = await ctx.ui.confirm(
			"⚠️ pi-bash-guard",
			`${why}\n\n${command}\n\n允许执行吗？`,
			{ timeout: approvalTimeoutMs() },
		);
		return { outcome: approved === true ? "approved" : "denied", elapsedMs: Date.now() - startedAt };
	} catch (error) {
		return {
			outcome: "error",
			elapsedMs: Date.now() - startedAt,
			dialogError: String(error instanceof Error ? error.message : error).slice(0, 200),
		};
	}
}

function blockReason(matchWhy: string, outcome: Outcome): string {
	switch (outcome) {
		case "no-ui":
			return `pi-bash-guard blocked "${matchWhy}": no dialog-capable UI available for approval (fail-closed).`;
		case "error":
			return `pi-bash-guard blocked "${matchWhy}": approval dialog failed (fail-closed).`;
		case "denied":
			return `pi-bash-guard blocked "${matchWhy}": not approved. Do not retry the same command; ask the user or choose a safer approach.`;
		default:
			return `pi-bash-guard blocked "${matchWhy}".`;
	}
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
		const match = matchDanger(command);
		if (!match) return;

		const { outcome, elapsedMs, dialogError } = await requestApproval(ctx, match.why, command);
		const timeoutMs = approvalTimeoutMs();
		audit({
			rule: match.id,
			why: match.why,
			outcome,
			mode: ctx.mode,
			hasUI: ctx.hasUI,
			elapsedMs,
			// A denial that consumed the whole dialog budget was most likely a timeout.
			timedOut: outcome === "denied" && elapsedMs >= Math.max(timeoutMs - 1000, timeoutMs * 0.9),
			dialogError,
			...commandFingerprint(command),
		});

		if (outcome === "approved") return;
		return { block: true, reason: blockReason(match.why, outcome) };
	});
}
