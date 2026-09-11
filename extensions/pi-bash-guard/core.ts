/**
 * pi-bash-guard — pure dangerous-command matching.
 *
 * Deliberately free of Pi imports so the matcher stays deterministic and
 * unit-testable (see tests/core.test.mjs).
 *
 * Matching runs against a normalized copy of the command (quotes stripped,
 * whitespace collapsed, lowercased) so trivial quoting and spacing variants
 * still match. This is a guardrail that forces a human decision, NOT a security
 * boundary: obfuscation can evade it. The rule list is intentionally
 * conservative to keep false positives low while the extension is a canary.
 */

export interface DangerRule {
	/** Stable id, used in the block reason and the audit log. */
	id: string;
	/** Human-readable explanation shown in the confirmation dialog. */
	why: string;
	/** Test against the normalized command, plus the raw command for case-sensitive flags. */
	test: (normalized: string, raw: string) => boolean;
}

export interface DangerMatch {
	id: string;
	why: string;
}

/** Strip quotes, collapse whitespace, lowercase. Used for matching only. */
export function normalizeCommand(command: string): string {
	return command.replace(/["'`]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Flag tokens that follow `command` in the normalized string. */
function flagsAfter(normalized: string, command: string): string[] {
	const tokens = normalized.split(" ");
	const index = tokens.findIndex((token) => token === command || token.endsWith(`/${command}`));
	if (index === -1) return [];
	return tokens.slice(index + 1).filter((token) => token.startsWith("-"));
}

function hasFlagMatching(normalized: string, command: string, test: (flag: string) => boolean): boolean {
	return flagsAfter(normalized, command).some(test);
}

function hasRecursiveFlag(normalized: string, command: string): boolean {
	return hasFlagMatching(
		normalized,
		command,
		(flag) => flag === "--recursive" || /^-[a-z]*r/i.test(flag),
	);
}

/** Dot-prefixed names: a leading backslash means a regex escape, not a path separator. */
const DOT_CREDENTIAL_MENTION = /(^|[\s/])\.(env|npmrc)(\s|$|[|;>])/;
/** Names without a leading dot: a backslash may be a Windows path separator. */
const PLAIN_CREDENTIAL_MENTION =
	/(^|[\s/\\])(auth\.json|models\.json|credentials|id_rsa|id_ed25519)(\s|$|[|;>])/;
const PEM_CREDENTIAL_MENTION = /(^|[\s/\\])[^\s/\\]*\.pem(\s|$|[|;>])/;

function mentionsCredential(normalized: string): boolean {
	return (
		DOT_CREDENTIAL_MENTION.test(normalized) ||
		PLAIN_CREDENTIAL_MENTION.test(normalized) ||
		PEM_CREDENTIAL_MENTION.test(normalized)
	);
}

/**
 * Split a raw command into simple shell segments.
 *
 * Separators inside quotes are preserved, so a `|` in a grep pattern or a
 * multi-line quoted argument stays in one segment. Heredoc bodies naturally
 * become their own segments, which keeps code lines from being read as shell
 * syntax.
 */
function splitSegments(raw: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			segments.push(current);
			current = "";
			continue;
		}
		if (ch === "|" || ch === "&") {
			segments.push(current);
			current = "";
			if (raw[i + 1] === ch) i += 1;
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * A real file redirect: `>` outside quotes, not fd handling.
 *
 * Ignores `=>` arrow functions, `->` arrows in prose, escaped `\>`, fd
 * duplication (`2>&1`, `>&2`), fd close (`>&-`), and discarded output
 * (`>/dev/null`). Quoted `>` (sed replacements, commit messages, code) is not
 * shell syntax and must not count.
 */
function hasFileRedirectInSegment(segment: string): boolean {
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;
		const previous = segment[i - 1] ?? "";
		if (previous === "=" || previous === "<" || previous === "-" || previous === "\\") continue;
		const rest = segment.slice(i).replace(/^>>?\s*/, "");
		if (rest.startsWith("&") || rest.startsWith("/dev/null") || rest === "" || rest.startsWith("|")) continue;
		return true;
	}
	return false;
}

/** Write-capable commands, word-bounded so a substring such as "bigmodel" cannot match "del". */
const WRITE_COMMAND_PATTERNS: readonly RegExp[] = [
	/\brm\b/,
	/\bdel\b/,
	/\berase\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\btee\b/,
	/\btruncate\b/,
	/\bunlink\b/,
	/\bsed\s+-i\b/,
	/\bset-content\b/,
	/\bout-file\b/,
];

/**
 * A credential-looking path written by a single shell segment.
 *
 * Evaluated per segment so a write command in one part of a compound command
 * (`tee /tmp/x`) cannot combine with a credential path read in another part.
 */
function writesCredentialFile(raw: string): boolean {
	for (const segment of splitSegments(raw)) {
		const normalized = normalizeCommand(segment);
		if (!mentionsCredential(normalized)) continue;
		if (hasFileRedirectInSegment(segment)) return true;
		if (WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
	}
	return false;
}

/**
 * The conservative canary rule set. Every rule forces a confirmation dialog;
 * none of them execute or rewrite the command.
 */
export const DANGER_RULES: readonly DangerRule[] = [
	{
		id: "rm-recursive",
		why: "recursive delete",
		test: (n) => /\brm\s/.test(n) && hasRecursiveFlag(n, "rm"),
	},
	{
		id: "windows-recursive-delete",
		why: "Windows recursive delete",
		test: (n) => /\b(del|erase)\s/.test(n) && /\s\/[a-z]*s/.test(n) || /\b(rd|rmdir)\s/.test(n) && /\s\/s/.test(n),
	},
	{
		id: "powershell-recursive-force",
		why: "PowerShell recursive force delete",
		test: (n) => /\b(remove-item|ri)\s/.test(n) && /-recurse/.test(n) && /-force/.test(n),
	},
	{
		id: "dd-write",
		why: "raw device/file write (dd of=)",
		test: (n) => /\bdd\s/.test(n) && /\bof=/.test(n),
	},
	{
		id: "disk-partition",
		why: "disk or partition operation",
		test: (n) => /\b(diskpart|mkfs(\.\w+)?)\b/.test(n) || /\bformat\s+[a-z]:/.test(n),
	},
	{
		id: "registry-delete",
		why: "registry delete",
		test: (n) => /\breg\s+delete\b/.test(n),
	},
	{
		id: "scheduled-task-delete",
		why: "scheduled task delete",
		test: (n) => /\bschtasks\b/.test(n) && /\/delete/.test(n),
	},
	{
		id: "git-force-push",
		why: "force push (--force or -f; --force-with-lease is allowed)",
		test: (n) => {
			if (!/\bgit\s+push\b/.test(n)) return false;
			const withoutLease = n.replace(/--force-with-lease(=\S+)?/g, " ");
			return /--force(\s|$)/.test(withoutLease) || hasFlagMatching(withoutLease, "push", (flag) => flag === "-f");
		},
	},
	{
		id: "git-reset-hard",
		why: "git reset --hard discards uncommitted work",
		test: (n) => /\bgit\s+reset\b/.test(n) && /--hard/.test(n),
	},
	{
		id: "git-clean-force",
		why: "git clean deletes untracked files",
		test: (n) => /\bgit\s+clean\b/.test(n) && hasFlagMatching(n, "clean", (flag) => /^-[a-z]*f/i.test(flag)),
	},
	{
		id: "git-checkout-discard",
		why: "git checkout . discards local changes",
		test: (n) => /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/.test(n),
	},
	{
		id: "git-branch-delete-force",
		why: "git branch -D force-deletes a branch",
		// Case-sensitive on purpose: -d (safe, merged-only) must not be flagged.
		test: (_n, raw) => /\bgit\s+branch\b[^|;&]*\s-D(\s|$)/.test(raw),
	},
	{
		id: "git-stash-destroy",
		why: "git stash drop/clear destroys stashed work",
		test: (n) => /\bgit\s+stash\s+(drop|clear)\b/.test(n),
	},
	{
		id: "publish",
		why: "package publish (irreversible)",
		// --dry-run is non-destructive and must not prompt.
		test: (n) => !/--dry-run/.test(n) && (/\bnpm\s+publish\b/.test(n) || /\btwine\s+upload\b/.test(n)),
	},
	{
		id: "pipe-to-shell",
		why: "piping a download into a shell",
		test: (n) => /\b(curl|wget|iwr|invoke-webrequest)\b/.test(n) && /\|\s*(sudo\s+)?(ba|z|k)?sh\b/.test(n),
	},
	{
		id: "credential-file-write",
		why: "write to a credential file",
		test: (_n, raw) => writesCredentialFile(raw),
	},
];

/** First matching rule for a raw command, or undefined when the command is not flagged. */
export function matchDanger(command: string): DangerMatch | undefined {
	const normalized = normalizeCommand(command);
	if (!normalized) return undefined;
	for (const rule of DANGER_RULES) {
		if (rule.test(normalized, command)) return { id: rule.id, why: rule.why };
	}
	return undefined;
}
