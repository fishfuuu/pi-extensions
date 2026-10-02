/**
 * /usage-dashboard — generate the token-usage dashboard and open it in a browser.
 *
 * On-demand by design: nothing is collected in the background and no server runs.
 * The command scans the local session files, writes one self-contained HTML file
 * (no external assets, no network) and hands it to the OS default browser.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateUsageDashboard, type QuotaPayload } from "./build.ts";

/**
 * Live remaining-quota readings for every provider with a pi-quota adapter.
 * Fail-open: pi-quota reports UNKNOWN on fetch errors, and a total failure just
 * leaves the dashboard's quota section out.
 */
async function collectQuota(ctx: ExtensionCommandContext): Promise<QuotaPayload[] | undefined> {
  try {
    // pi-quota is an optional companion: importing it lazily keeps this extension
    // installable on its own. Without it the quota section is simply omitted, the
    // same fail-open behavior as a failed fetch.
    const { fetchAllQuotaSnapshots } = await import("../pi-quota/snapshot.ts");
    const snapshots = await fetchAllQuotaSnapshots(ctx.modelRegistry);
    const out: QuotaPayload[] = [...snapshots.values()].map((snap) => ({
      provider: snap.provider,
      status: snap.status,
      tightestRemainingPct: snap.tightestRemainingPct,
      windows: snap.windows.map((w) => ({
        label: w.label,
        remainingPct: w.remainingPct,
        usedPct: w.usedPct,
        resetAt: w.resetAt,
      })),
      balances: snap.balances?.map((b) => ({ currency: b.currency, amount: b.amount, available: b.available })),
      error: snap.error,
    }));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Hand a local file to the OS default application without going through a shell. */
function openInBrowser(path: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? (["cmd", ["/c", "start", "", path]] as const)
      : process.platform === "darwin"
        ? (["open", [path]] as const)
        : (["xdg-open", [path]] as const);
  try {
    spawn(cmd, [...args], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening is a convenience; the notify below still reports the path.
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage-dashboard", {
    description: "扫描本机所有 pi 会话生成用量仪表盘（HTML）并打开；加 no-open 只生成不打开",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const noOpen = /\bno-open\b/i.test(args);
      try {
        // Quota is gathered first so the HTML carries one coherent snapshot.
        const quota = await collectQuota(ctx);
        const result = await generateUsageDashboard({ quota });
        const { stats } = result;
        ctx.ui.notify(
          [
            `用量仪表盘已生成（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`,
            `${stats.records.toLocaleString()} 条记录 · ${stats.sessions} 个会话 · ${stats.projects} 个项目`,
            `成本 $${stats.cost.toFixed(2)} · fresh token ${(stats.freshTokens / 1e6).toFixed(1)}M · 缓存读取 ${(stats.cacheReadTokens / 1e6).toFixed(1)}M`,
            quota
              ? `额度已获取：${quota
                  .map((q) =>
                    q.windows.length
                      ? `${q.provider} ${q.tightestRemainingPct === undefined ? q.status.toLowerCase() : `${q.tightestRemainingPct.toFixed(0)}%`}`
                      : q.balances?.length
                        ? `${q.provider} ${q.balances.map((b) => `${b.currency} ${b.amount}`).join(" / ")}`
                        : `${q.provider} ${q.status.toLowerCase()}`,
                  )
                  .join(" · ")}`
              : "额度未获取（本机无可用适配器或抓取失败）",
            result.htmlPath,
          ].join("\n"),
          "info",
        );
        if (!noOpen) openInBrowser(result.htmlPath);
      } catch (err) {
        ctx.ui.notify(`生成用量仪表盘失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
