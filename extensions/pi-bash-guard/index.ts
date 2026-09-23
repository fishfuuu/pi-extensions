/**
 * pi-bash-guard — confirm dangerous bash commands before they run.
 *
 * CANARY: opt-in only. This extension is deliberately NOT part of the package
 * manifest yet; it is installed by local path while false positives/negatives
 * are evaluated. See README.md.
 *
 * Behavior:
 *  - every bash and powershell tool call is matched against the conservative
 *    rule set in core.ts (Pi's builtin powershell tool shares BashToolInput)
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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchDanger } from "./core.ts";
import {
	actionFor,
	loadPolicyConfig,
	resolveEnabledForCwd,
	resolvePolicyForCwd,
} from "./policy.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LOG_PATH = join(AGENT_DIR, "pi-bash-guard.log");
const POLICY_CONFIG_PATH = join(AGENT_DIR, "pi-bash-guard.json");
const KNOWN_CATEGORIES = [
	"recursive-delete",
	"destructive-git",
	"credential-write",
	"system-destructive",
	"publish",
];

function fsExists(p: string): boolean {
	try {
		return existsSync(p);
	} catch {
		return false;
	}
}

function fsReadFile(p: string): string {
	return readFileSync(p, "utf8");
}

function fsWriteFile(p: string, content: string): void {
	writeFileSync(p, content, "utf8");
}
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

/**
 * Toggle the top-level `enabled` flag in the user config.
 *
 * Refuses to overwrite a corrupt config file: on/off must not silently destroy
 * the user's project policies. Fix the JSON by hand in that case.
 */
function setGuardEnabled(enabled: boolean): { ok: boolean; message: string } {
	let config: Record<string, unknown> = {};
	if (fsExists(POLICY_CONFIG_PATH)) {
		try {
			const parsed: unknown = JSON.parse(fsReadFile(POLICY_CONFIG_PATH));
			if (!isRecord(parsed)) return { ok: false, message: "config file is not a JSON object; fix it manually" };
			config = parsed;
		} catch (error) {
			return {
				ok: false,
				message: `config file is not valid JSON (${String(error).slice(0, 120)}); fix it manually to use on/off`,
			};
		}
	}
	config.enabled = enabled;
	try {
		fsWriteFile(POLICY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch (error) {
		return { ok: false, message: `config write failed: ${String(error).slice(0, 120)}` };
	}
	return { ok: true, message: enabled ? "enabled" : "disabled" };
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
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;

		const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
		const match = matchDanger(command);
		if (!match) return;

		// Policy is re-read per call so /bash-guard on|off takes effect immediately.
		// Fail-safe: a missing/corrupt config falls back to built-in defaults.
		const policyConfig = loadPolicyConfig(POLICY_CONFIG_PATH, KNOWN_CATEGORIES);
		for (const issue of policyConfig.diagnostics) audit({ type: "config", issue });

		// The most specific matching project may override the global enabled flag.
		const enabledResolution = resolveEnabledForCwd(policyConfig, ctx.cwd);
		if (!enabledResolution.effective) return; // disabled here: inert, no dialogs, no audit

		const { projectRoot, policy } = resolvePolicyForCwd(policyConfig, ctx.cwd, KNOWN_CATEGORIES);
		const action = actionFor(policy, match.category);

		audit({
			rule: match.id,
			category: match.category,
			action,
			project: projectRoot,
			why: match.why,
			outcome: action === "confirm" ? "confirm-requested" : `policy-${action}`,
			mode: ctx.mode,
			hasUI: ctx.hasUI,
			...commandFingerprint(command),
		});

		if (action === "allow") return;

		if (action === "block") {
			return { block: true, reason: `pi-bash-guard blocked "${match.why}" (policy: block for ${match.category}).` };
		}

		// action === "confirm"
		const { outcome, elapsedMs, dialogError } = await requestApproval(ctx, match.why, command);
		const timeoutMs = approvalTimeoutMs();
		audit({
			rule: match.id,
			category: match.category,
			action: "confirm",
			project: projectRoot,
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

	pi.registerCommand("bash-guard", {
		description: "pi-bash-guard status/on/off",
		handler: async (args, ctx) => {
			const sub = String(args ?? "").trim().split(/\s+/)[0].toLowerCase() || "status";

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				const result = setGuardEnabled(enabled);
				ctx.ui.notify(`pi-bash-guard ${result.message}`, result.ok ? "info" : "error");
				return;
			}

			if (sub !== "status") {
				ctx.ui.notify("usage: /bash-guard [status | on | off]", "warning");
				return;
			}

			const policyConfig = loadPolicyConfig(POLICY_CONFIG_PATH, KNOWN_CATEGORIES);
			const enabledResolution = resolveEnabledForCwd(policyConfig, ctx.cwd);
			const { projectRoot, policy } = resolvePolicyForCwd(policyConfig, ctx.cwd, KNOWN_CATEGORIES);
			const projectEnabledText = projectRoot
				? enabledResolution.projectEnabled === undefined
					? "not set — inherits global"
					: enabledResolution.projectEnabled
						? "yes"
						: "no"
				: "(no project match)";
			const lines = [
				"pi-bash-guard",
				"",
				`Enabled (global):    ${policyConfig.enabled ? "yes" : "no"}`,
				`Enabled (project):   ${projectEnabledText}`,
				`Enabled (effective): ${enabledResolution.effective ? "yes" : "no"}`,
				`Project:             ${projectRoot ?? "(none — global default)"}`,
				"",
			];
			for (const category of KNOWN_CATEGORIES) {
				lines.push(`${category.padEnd(20)}${actionFor(policy, category)}`);
			}
			for (const issue of policyConfig.diagnostics) lines.push(`config: ${issue}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
