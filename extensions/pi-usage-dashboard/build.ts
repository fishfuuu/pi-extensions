/**
 * Usage dashboard generator.
 *
 * Scans every pi session file under <agentDir>/sessions (recursively, including
 * nested child-agent runs), de-duplicates repeated assistant messages, and
 * renders a single self-contained HTML dashboard from template.html.
 *
 * The HTML has no external dependencies: the record set is inlined as JSON and
 * every chart is hand-drawn SVG/CSS, so the file works offline and can be opened
 * straight from disk.
 *
 * Deliberately runnable standalone (`node` can import this file) so the numbers
 * can be verified without a pi process.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, "template.html");

export interface DashboardStats {
  files: number;
  records: number;
  providers: number;
  models: number;
  projects: number;
  sessions: number;
  cost: number;
  freshTokens: number;
  cacheReadTokens: number;
}

/** One provider's live remaining-quota reading, inlined into the snapshot HTML. */
export interface QuotaWindowPayload {
  label: string;
  remainingPct?: number;
  usedPct?: number;
  resetAt?: number;
}

export interface QuotaBalancePayload {
  currency: string;
  amount: string;
  available: boolean;
}

export interface QuotaPayload {
  provider: string;
  status: string;
  tightestRemainingPct?: number;
  windows: QuotaWindowPayload[];
  /** Balance-based providers (e.g. DeepSeek) report money instead of windows. */
  balances?: QuotaBalancePayload[];
  error?: string;
}

export interface DashboardResult {
  htmlPath: string;
  bytes: number;
  stats: DashboardStats;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".jsonl")) yield p;
  }
}

export interface GenerateOptions {
  /** Output directory (defaults to <agentDir>/usage-dashboard). */
  outDir?: string;
  /** Session root (defaults to <agentDir>/sessions). */
  sessionsDir?: string;
  /**
   * Live remaining-quota readings. Fetched by the extension command (needs a pi
   * ModelRegistry); absent when this module is run standalone with node.
   */
  quota?: QuotaPayload[];
}

export async function generateUsageDashboard(options: GenerateOptions = {}): Promise<DashboardResult> {
  const sessionsDir = options.sessionsDir ?? join(agentDir(), "sessions");
  const outDir = options.outDir ?? join(agentDir(), "usage-dashboard");

  const providers: string[] = [];
  const models: string[] = [];
  const projects: string[] = [];
  const sessions: string[] = [];
  const providerIndex = new Map<string, number>();
  const modelIndex = new Map<string, number>();
  const projectIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();
  const intern = (map: Map<string, number>, list: string[], key: string): number => {
    let i = map.get(key);
    if (i === undefined) {
      i = list.length;
      list.push(key);
      map.set(key, i);
    }
    return i;
  };

  // [tMs, provider, model, input, output, cacheRead, cacheWrite, cost, reasoning,
  //  project, isChild, session, costInput, costCacheRead]
  const records: Array<Array<number>> = [];
  const seen = new Set<string>();
  let files = 0;

  for await (const file of walk(sessionsDir)) {
    files++;
    const isChild = relative(sessionsDir, file).split(sep).length > 2;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let sessionId = file;
    let cwd: string | null = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "session") {
        sessionId = entry.id ?? sessionId;
        cwd = entry.cwd ?? cwd;
        continue;
      }
      const message = entry.message;
      if (!message || message.role !== "assistant" || !message.usage) continue;
      const usage = message.usage;
      // Main session files store ISO timestamps; nested child-run files store
      // epoch milliseconds. Accept both.
      const rawTs = message.timestamp ?? entry.timestamp;
      const t = typeof rawTs === "number" ? rawTs : Date.parse(rawTs ?? "");
      if (!Number.isFinite(t)) continue;
      const provider = message.provider ?? "unknown";
      const model = message.model ?? "unknown";
      const tokens =
        usage.totalTokens ??
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (!tokens) continue;
      // Branch copies and nested-run copies repeat the same assistant message.
      const dedupKey = `${provider}|${model}|${t}|${tokens}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      records.push([
        t,
        intern(providerIndex, providers, provider),
        intern(modelIndex, models, model),
        usage.input ?? 0,
        usage.output ?? 0,
        usage.cacheRead ?? 0,
        usage.cacheWrite ?? 0,
        usage.cost?.total ?? 0,
        usage.reasoning ?? 0,
        intern(projectIndex, projects, cwd ? basename(cwd) || cwd : "(unknown)"),
        isChild ? 1 : 0,
        intern(sessionIndex, sessions, sessionId),
        usage.cost?.input ?? 0,
        usage.cost?.cacheRead ?? 0,
      ]);
    }
  }

  records.sort((a, b) => a[0] - b[0]);

  const payload = {
    generatedAt: new Date().toISOString(),
    providers,
    models,
    projects,
    records,
    quota: options.quota,
    stats: { files, kept: records.length },
  };

  const template = await readFile(TEMPLATE_PATH, "utf8");
  // `<` is escaped so inlined session/model/project names can never break out of
  // the surrounding <script> block.
  const html = template.replace("/*__PAYLOAD__*/null", JSON.stringify(payload).replaceAll("<", "\\u003c"));
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "index.html");
  await writeFile(htmlPath, html, "utf8");

  let cost = 0;
  let freshTokens = 0;
  let cacheReadTokens = 0;
  const uniqueSessions = new Set<number>();
  for (const r of records) {
    cost += r[7];
    freshTokens += r[3] + r[4] + r[6];
    cacheReadTokens += r[5];
    uniqueSessions.add(r[11]);
  }

  return {
    htmlPath,
    bytes: Buffer.byteLength(html, "utf8"),
    stats: {
      files,
      records: records.length,
      providers: providers.length,
      models: models.length,
      projects: projects.length,
      sessions: uniqueSessions.size,
      cost,
      freshTokens,
      cacheReadTokens,
    },
  };
}
