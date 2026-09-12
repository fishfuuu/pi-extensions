/**
 * pi-bash-guard — user-level policy configuration.
 *
 * Config file (user scope only): ~/.pi/agent/pi-bash-guard.json
 * (or $PI_CODING_AGENT_DIR/pi-bash-guard.json)
 *
 * Project repositories cannot weaken the guard: project-local config files are
 * never read. The only override surface is the `projects` map inside THIS file,
 * which the user controls.
 *
 * Fail-safe contract:
 *  - missing / corrupt / invalid config → guard stays ENABLED with built-in defaults
 *  - invalid actions are dropped and the category falls back to the built-in default
 *  - every problem is recorded as a short diagnostic; Pi startup never fails
 */

import { GUARD_CATEGORIES } from "./core.ts";

export type GuardAction = "allow" | "confirm" | "block";

export const GUARD_ACTIONS: readonly GuardAction[] = ["allow", "confirm", "block"];

/**
 * Built-in safe defaults, applied when the config file is missing, corrupt, or
 * silent about a category. High-loss operations (system-destructive) block by
 * default; the rest confirm. Never fail-open: a broken config must not weaken
 * these.
 */
export const BUILT_IN_DEFAULT_POLICY: CategoryPolicy = {
	"recursive-delete": "confirm",
	"destructive-git": "confirm",
	"credential-write": "confirm",
	"system-destructive": "block",
	publish: "confirm",
};

export type CategoryPolicy = Record<string, GuardAction>;

export interface ProjectPolicy {
	/** Normalized project root (lowercase, forward slashes, no trailing slash). */
	root: string;
	/** Explicit project-level on/off; undefined inherits the global setting. */
	enabled?: boolean;
	/** Only the categories the project explicitly overrides. */
	overrides: Record<string, GuardAction>;
}

export interface ResolvedPolicyConfig {
	enabled: boolean;
	defaultPolicy: CategoryPolicy;
	projects: ProjectPolicy[];
	/** Human-readable config problems, for the audit log. */
	diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGuardAction(value: unknown): value is GuardAction {
	return value === "allow" || value === "confirm" || value === "block";
}

/** Normalize a project root: backslashes → slashes, lowercase, no trailing slash. */
export function normalizeProjectPath(p: string): string {
	return String(p ?? "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** Does `cwd` live inside (or equal) the normalized project root? */
export function matchesProjectRoot(cwd: string, root: string): boolean {
	const normalizedCwd = normalizeProjectPath(cwd);
	if (!root) return false;
	return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
}

/** Sanitize a category→action map; invalid entries are dropped with diagnostics. */
function sanitizeActionMap(
	raw: unknown,
	source: string,
	diagnostics: string[],
	knownCategories: readonly string[],
): Record<string, GuardAction> {
	const out: Record<string, GuardAction> = {};
	if (raw === undefined) return out;
	if (!isRecord(raw)) {
		diagnostics.push(`${source} must be an object; ignored`);
		return out;
	}
	for (const [key, value] of Object.entries(raw)) {
		if (!knownCategories.includes(key)) {
			diagnostics.push(`unknown category '${key}' in ${source}; ignored`);
			continue;
		}
		if (!isGuardAction(value)) {
			diagnostics.push(`invalid action '${String(value)}' for '${key}' in ${source}; ignored`);
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Load and validate the policy config. Never throws; every problem becomes a
 * diagnostic and the guard falls back to safe defaults.
 */
export function loadPolicyConfig(
	configPath: string,
	knownCategories: readonly string[] = GUARD_CATEGORIES,
): ResolvedPolicyConfig {
	const diagnostics: string[] = [];

	const failSafe = (): ResolvedPolicyConfig => ({ enabled: true, defaultPolicy: {}, projects: [], diagnostics });

	// Missing file is not a diagnostic: the no-config default IS the built-in policy.
	if (!fsExists(configPath)) {
		return { enabled: true, defaultPolicy: {}, projects: [], diagnostics };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(fsReadFile(configPath));
	} catch (error) {
		diagnostics.push(`config is not valid JSON, using built-in defaults: ${String(error).slice(0, 160)}`);
		return failSafe();
	}
	if (!isRecord(raw)) {
		diagnostics.push("config root must be an object, using built-in defaults");
		return failSafe();
	}

	let enabled = true;
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") enabled = raw.enabled;
		else diagnostics.push("enabled must be a boolean; using true");
	}

	const defaultPolicy = sanitizeActionMap(raw.default, "default", diagnostics, knownCategories);

	const projects: ProjectPolicy[] = [];
	if (raw.projects !== undefined) {
		if (!isRecord(raw.projects)) {
			diagnostics.push("projects must be an object; ignored");
		} else {
			for (const [root, value] of Object.entries(raw.projects)) {
				const normalized = normalizeProjectPath(root);
				if (!normalized) {
					diagnostics.push(`project root '${root}' is empty; ignored`);
					continue;
				}
				if (!isRecord(value)) {
					diagnostics.push(`policy for project '${root}' must be an object; ignored`);
					continue;
				}
				let projectEnabled: boolean | undefined;
				if (value.enabled !== undefined) {
					if (typeof value.enabled === "boolean") projectEnabled = value.enabled;
					else diagnostics.push(`enabled for project '${root}' must be a boolean; ignored`);
				}
				const { enabled: _ignored, ...categoryOverrides } = value;
				const overrides = sanitizeActionMap(categoryOverrides, `project '${root}'`, diagnostics, knownCategories);
				projects.push({ root: normalized, enabled: projectEnabled, overrides });
			}
		}
	}

	return { enabled, defaultPolicy, projects, diagnostics };
}

// --- Minimal fs indirection so policy tests can inject a fake fs if needed ---
// (kept tiny on purpose; the config file is a few dozen lines at most)

import * as fsNode from "node:fs";

function fsExists(p: string): boolean {
	try {
		return fsNode.existsSync(p);
	} catch {
		return false;
	}
}

function fsReadFile(p: string): string {
	return fsNode.readFileSync(p, "utf8");
}

/**
 * Effective policy for a cwd: built-in fallbacks + default policy + the most
 * specific matching project override. Unknown categories in the result default
 * to "confirm" (the safest interactive choice).
 */
export function resolvePolicyForCwd(
	config: ResolvedPolicyConfig,
	cwd: string,
	knownCategories: readonly string[] = GUARD_CATEGORIES,
): { projectRoot: string | undefined; policy: CategoryPolicy } {
	// Layer 1: built-in safe defaults (system-destructive is "block" here).
	// Layer 2: explicit user overrides from the config. Absent entries keep layer 1 —
	// an empty or partial config must never downgrade a category to "confirm".
	const policy: CategoryPolicy = { ...BUILT_IN_DEFAULT_POLICY };
	for (const category of knownCategories) {
		const override = config.defaultPolicy[category];
		if (override) policy[category] = override;
	}

	let projectRoot: string | undefined;
	let bestLength = -1;
	for (const project of config.projects) {
		if (matchesProjectRoot(cwd, project.root) && project.root.length > bestLength) {
			bestLength = project.root.length;
			projectRoot = project.root;
		}
	}
	if (projectRoot) {
		const overrides = config.projects.find((project) => project.root === projectRoot)?.overrides ?? {};
		for (const [category, action] of Object.entries(overrides)) policy[category] = action;
	}

	return { projectRoot, policy };
}

export interface EnabledResolution {
	/** The user-level global setting. */
	globalEnabled: boolean;
	/** The most specific matching project root, if any. */
	projectRoot: string | undefined;
	/** The matching project's explicit enabled, when it sets one. */
	projectEnabled: boolean | undefined;
	/** What the guard should do at this cwd. */
	effective: boolean;
}

/**
 * Resolve the on/off decision for a cwd.
 *
 * The most specific matching project wins; if it does not explicitly set
 * `enabled`, the global setting applies. Projects that merely match but do not
 * set the flag are not stacked.
 */
export function resolveEnabledForCwd(config: ResolvedPolicyConfig, cwd: string): EnabledResolution {
	let projectRoot: string | undefined;
	let projectEnabled: boolean | undefined;
	let bestLength = -1;
	for (const project of config.projects) {
		if (!matchesProjectRoot(cwd, project.root)) continue;
		if (project.root.length <= bestLength) continue;
		bestLength = project.root.length;
		projectRoot = project.root;
		projectEnabled = project.enabled;
	}
	const effective = projectEnabled !== undefined ? projectEnabled : config.enabled;
	return { globalEnabled: config.enabled, projectRoot, projectEnabled, effective };
}

/** Action for a category from a resolved policy, defaulting to confirm. */
export function actionFor(policy: CategoryPolicy, category: string): GuardAction {
	const action = policy[category];
	return isGuardAction(action) ? action : "confirm";
}
