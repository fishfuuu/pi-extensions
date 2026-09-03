/**
 * pi-quota — on-demand /quota for configured providers with a known adapter.
 * No polling, no tools, no cookie, no secret persistence.
 */
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { compactWidgetLines } from "./core.ts";
import { discoverQuotaTargets, originOf, type QuotaTarget } from "./discover.ts";
import { showQuotaPanel, type MixRow, type QuotaCard } from "./ui.ts";

const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const XAI_USER = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const XAI_BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OLLAMA_USAGE = "https://ollama.com/api/usage";
const DEEPSEEK_BALANCE = "https://api.deepseek.com/user/balance";
const TIMEOUT_MS = 10_000;
const XAI_HEADERS = {
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": "1.0.10",
  "x-grok-client-mode": "interactive",
} as const;

type Status =
  | "OK"
  | "MISSING_CREDENTIAL"
  | "AUTH_INVALID"
  | "RATE_LIMITED"
  | "ENDPOINT_MISSING"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "SCHEMA_MISMATCH"
  | "SERVER_ERROR"
  | "UNSUPPORTED_AUTH"
  | "SECOND_ACCOUNT_NOT_CONFIGURED";

function formatResetLocal(input?: number | string): string | undefined {
  let date: Date | undefined;
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    date = new Date(input > 1e12 ? input : input * 1000);
  } else if (typeof input === "string" && input.trim()) {
    const ms = Date.parse(input);
    if (Number.isFinite(ms)) date = new Date(ms);
  }
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const stamp = `${months[date.getMonth()]} ${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.getFullYear() !== now.getFullYear() ? `${date.getFullYear()} ${stamp}` : stamp;
}

function durationLabel(seconds?: number): string {
  if (seconds === 18000) return "5h";
  if (seconds === 604800) return "7d";
  if (typeof seconds === "number" && seconds > 0) {
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    return `${Math.round(seconds / 3600)}h`;
  }
  return "win";
}

function displayModel(name: string): string {
  if (name === "glm-5.3") return "GLM-5.3";
  if (name === "glm-5.3-flash") return "GLM-5.3-Flash";
  if (name === "deepseek-v4-flash:0731") return "DeepSeek V4";
  return name;
}

function classifyHttp(status: number): Status {
  if (status === 401 || status === 403) return "AUTH_INVALID";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "ENDPOINT_MISSING";
  if (status >= 500) return "SERVER_ERROR";
  return "NETWORK_ERROR";
}

function isAllowedHttpsUrl(url: string, allowedHost: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === allowedHost;
  } catch {
    return false;
  }
}

function headerMap(headers?: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

function bearerFrom(headers: Record<string, string>, apiKey?: string): string | undefined {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  if (m?.[1]) return m[1];
  return apiKey;
}

async function fetchJson(
  url: string,
  allowedHost: string,
  headers: Record<string, string>,
): Promise<{ status: Status; data?: unknown }> {
  if (!isAllowedHttpsUrl(url, allowedHost)) return { status: "NETWORK_ERROR" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "manual",
      signal: ac.signal,
    });
    if (res.status >= 300 && res.status < 400) return { status: "NETWORK_ERROR" };
    if (!isAllowedHttpsUrl(res.url || url, allowedHost)) return { status: "NETWORK_ERROR" };
    if (!res.ok) return { status: classifyHttp(res.status) };
    const text = await res.text();
    if (text.length > 64_000) return { status: "SCHEMA_MISMATCH" };
    return { status: "OK", data: JSON.parse(text) as unknown };
  } catch (err) {
    const msg = String(err);
    if (err instanceof Error && err.name === "AbortError") return { status: "TIMEOUT" };
    if (/timeout/i.test(msg)) return { status: "TIMEOUT" };
    return { status: "NETWORK_ERROR" };
  } finally {
    clearTimeout(timer);
  }
}

function asRec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function moneyText(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return undefined;
}

async function piAuth(
  registry: ModelRegistry,
  provider: string,
  officialOrigin: string,
): Promise<{ status: Status; headers?: Record<string, string> }> {
  const stored = readStoredCredential(provider);
  if (!stored) return { status: "MISSING_CREDENTIAL" };
  if (stored.type !== "oauth") return { status: "UNSUPPORTED_AUTH" };
  let resolved: Awaited<ReturnType<ModelRegistry["getProviderAuth"]>>;
  try {
    resolved = await registry.getProviderAuth(provider);
  } catch {
    return { status: "NETWORK_ERROR" };
  }
  if (!resolved?.auth) return { status: "MISSING_CREDENTIAL" };
  const origin = originOf(resolved.auth.baseUrl);
  if (origin && origin !== officialOrigin) return { status: "UNSUPPORTED_AUTH" };
  const headers = headerMap(resolved.auth.headers);
  const token = bearerFrom(headers, resolved.auth.apiKey);
  if (!token) return { status: "MISSING_CREDENTIAL" };
  if (typeof stored.access === "string" && stored.access && stored.access !== token) {
    return { status: "UNSUPPORTED_AUTH" };
  }
  return { status: "OK", headers: { Authorization: `Bearer ${token}` } };
}

function errCard(providerId: string, title: string, error: string): QuotaCard {
  return { providerId, title, error, rows: [] };
}

async function queryCodex(registry: ModelRegistry, target: QuotaTarget): Promise<QuotaCard> {
  const title = target.displayName;
  const auth = await piAuth(registry, target.providerId, "https://chatgpt.com");
  if (auth.status !== "OK" || !auth.headers) return errCard(target.providerId, title, auth.status);
  const { status, data } = await fetchJson(CODEX_USAGE, "chatgpt.com", auth.headers);
  if (status !== "OK") return errCard(target.providerId, title, status);
  const root = asRec(data);
  const rl = asRec(root?.rate_limit);
  const primary = asRec(rl?.primary_window);
  const secondary = asRec(rl?.secondary_window);
  const pUsed = asNum(primary?.used_percent);
  const sUsed = asNum(secondary?.used_percent);
  if (pUsed === undefined && sUsed === undefined) return errCard("codex", title, "SCHEMA_MISMATCH");
  const rows = [];
  if (pUsed !== undefined) {
    rows.push({
      label: durationLabel(asNum(primary?.limit_window_seconds)),
      usedPct: pUsed,
      reset: formatResetLocal(asNum(primary?.reset_at)),
    });
  }
  if (sUsed !== undefined) {
    rows.push({
      label: durationLabel(asNum(secondary?.limit_window_seconds)),
      usedPct: sUsed,
      reset: formatResetLocal(asNum(secondary?.reset_at)),
    });
  }
  return { providerId: target.providerId, title, rows };
}

async function queryXai(registry: ModelRegistry, target: QuotaTarget): Promise<QuotaCard> {
  const title = target.displayName;
  const auth = await piAuth(registry, target.providerId, "https://api.x.ai");
  if (auth.status !== "OK" || !auth.headers) return errCard(target.providerId, title, auth.status);
  const headers = { ...auth.headers, ...XAI_HEADERS };
  const user = await fetchJson(XAI_USER, "cli-chat-proxy.grok.com", headers);
  if (user.status !== "OK") return errCard(target.providerId, title, user.status);
  const userObj = asRec(user.data);
  const userId = asStr(userObj?.userId);
  const tier = asStr(userObj?.subscriptionTier);
  if (!userId || !/^[A-Za-z0-9._~-]{1,128}$/.test(userId)) return errCard(target.providerId, title, "SCHEMA_MISMATCH");
  const billing = await fetchJson(XAI_BILLING, "cli-chat-proxy.grok.com", {
    ...headers,
    "x-userid": userId,
  });
  if (billing.status !== "OK") return errCard(target.providerId, title, billing.status);
  const cfg = asRec(asRec(billing.data)?.config);
  if (!cfg) return errCard(target.providerId, title, "SCHEMA_MISMATCH");
  const pct = asNum(cfg.creditUsagePercent);
  const period = asRec(cfg.currentPeriod);
  const pType = asStr(period?.type);
  let label = "win";
  if (pType === "USAGE_PERIOD_TYPE_WEEKLY") label = "7d";
  else if (pType === "USAGE_PERIOD_TYPE_MONTHLY") label = "30d";
  const extras: string[] = [];
  const onCap = asNum(asRec(cfg.onDemandCap)?.val);
  const onUsed = asNum(asRec(cfg.onDemandUsed)?.val);
  if ((onCap && onCap !== 0) || (onUsed && onUsed !== 0)) {
    extras.push(
      `On-demand $${onUsed !== undefined ? (onUsed / 100).toFixed(2) : "?"} / $${onCap !== undefined ? (onCap / 100).toFixed(2) : "?"}`,
    );
  }
  const pre = asNum(asRec(cfg.prepaidBalance)?.val);
  if (pre && pre !== 0) extras.push(`Prepaid $${(pre / 100).toFixed(2)}`);
  return {
    providerId: target.providerId,
    title,
    rows: pct === undefined ? [] : [{ label, usedPct: pct, reset: formatResetLocal(asStr(period?.end)) }],
    plan: tier,
    extras,
  };
}

function ollamaLimitOk(v: unknown): v is { usage: number; models?: unknown } {
  const rec = asRec(v);
  const usage = asNum(rec?.usage);
  if (usage === undefined || usage < 0 || usage > 1) return false;
  if (rec?.models !== undefined && !Array.isArray(rec.models)) return false;
  return true;
}

function mixRows(models: unknown): MixRow[] {
  if (!Array.isArray(models)) return [];
  const rows: MixRow[] = [];
  for (const item of models) {
    const rec = asRec(item);
    const name = asStr(rec?.name);
    const n = asNum(rec?.request_count);
    if (!name || n === undefined) continue;
    rows.push({ name: displayModel(name), requests: Math.max(0, Math.round(n)) });
  }
  rows.sort((a, b) => b.requests - a.requests);
  return rows;
}

async function queryOllama(registry: ModelRegistry, target: QuotaTarget): Promise<QuotaCard> {
  const title = target.displayName;
  const sample = registry.getAll().find((m) => m.provider === target.providerId);
  if (originOf(sample?.baseUrl) !== "https://ollama.com") {
    return errCard(target.providerId, title, "UNSUPPORTED_AUTH");
  }
  let key: string | undefined;
  try {
    key = await registry.getApiKeyForProvider(target.providerId);
  } catch {
    return errCard(target.providerId, title, "NETWORK_ERROR");
  }
  if (!key) return errCard(target.providerId, title, "MISSING_CREDENTIAL");
  const { status, data } = await fetchJson(OLLAMA_USAGE, "ollama.com", {
    Authorization: `Bearer ${key}`,
  });
  if (status !== "OK") return errCard(target.providerId, title, status);
  const limits = asRec(asRec(data)?.limits);
  if (!ollamaLimitOk(limits?.session) || !ollamaLimitOk(limits?.weekly)) {
    return errCard(target.providerId, title, "SCHEMA_MISMATCH");
  }
  const session = limits.session as { usage: number; models?: unknown };
  const weekly = limits.weekly as { usage: number; models?: unknown };
  const weeklyMix = Array.isArray(weekly.models) ? mixRows(weekly.models) : [];
  const sessionMix = Array.isArray(session.models) ? mixRows(session.models) : [];
  const mix = weeklyMix.length ? weeklyMix : sessionMix;
  return {
    providerId: target.providerId,
    title,
    rows: [
      { label: "5h", usedPct: session.usage * 100 },
      { label: "Weekly", usedPct: weekly.usage * 100 },
    ],
    mix,
    mixWeekly: weeklyMix.length > 0,
  };
}

async function queryDeepseek(registry: ModelRegistry, target: QuotaTarget): Promise<QuotaCard> {
  const title = target.displayName;
  const native = registry.getProvider(target.providerId);
  const sample = registry.getAll().find((m) => m.provider === target.providerId);
  const origin = originOf(sample?.baseUrl) ?? originOf(native?.baseUrl);
  if (origin !== "https://api.deepseek.com") {
    return errCard(target.providerId, title, "UNSUPPORTED_AUTH");
  }
  let key: string | undefined;
  try {
    key = await registry.getApiKeyForProvider(target.providerId);
  } catch {
    return errCard(target.providerId, title, "NETWORK_ERROR");
  }
  if (!key) return errCard(target.providerId, title, "MISSING_CREDENTIAL");
  const { status, data } = await fetchJson(DEEPSEEK_BALANCE, "api.deepseek.com", {
    Authorization: `Bearer ${key}`,
  });
  if (status !== "OK") return errCard(target.providerId, title, status);
  const root = asRec(data);
  const available = asBool(root?.is_available);
  const infos = root?.balance_infos;
  if (available === undefined || !Array.isArray(infos) || infos.length === 0) {
    return errCard(target.providerId, title, "SCHEMA_MISMATCH");
  }
  const balances = [];
  for (const item of infos) {
    const rec = asRec(item);
    const currency = asStr(rec?.currency);
    const amount = moneyText(rec?.total_balance);
    if (!currency || !/^[A-Z]{3}$/.test(currency) || amount === undefined) {
      return errCard(target.providerId, title, "SCHEMA_MISMATCH");
    }
    balances.push({ currency, amount, available });
  }
  return { providerId: target.providerId, title, rows: [], balances };
}

function queryTarget(registry: ModelRegistry, target: QuotaTarget): Promise<QuotaCard> {
  if (target.adapter === "codex") return queryCodex(registry, target);
  if (target.adapter === "xai") return queryXai(registry, target);
  if (target.adapter === "deepseek-official") return queryDeepseek(registry, target);
  return queryOllama(registry, target);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quota", {
    description: "Show quota for configured providers that pi-quota can query",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const want = args.trim();
      const targets = discoverQuotaTargets(ctx.modelRegistry);
      const selected = want ? targets.filter((t) => t.providerId === want) : targets;
      if (want && selected.length === 0) {
        ctx.ui.notify(`Unknown or unsupported quota provider: ${want}`, "warning");
        return;
      }
      if (selected.length === 0) {
        ctx.ui.notify("No configured providers with a supported quota adapter.", "info");
        return;
      }
      const cards = await Promise.all(selected.map((t) => queryTarget(ctx.modelRegistry, t)));
      ctx.ui.setWidget("pi-quota", compactWidgetLines(cards), { placement: "belowEditor" });
      const opened = await showQuotaPanel(ctx, cards);
      if (!opened) ctx.ui.notify("Quota loaded. Open the pi-quota tab.", "info");
    },
  });
}
