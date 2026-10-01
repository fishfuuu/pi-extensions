/**
 * /usage-dashboard — generate the token-usage dashboard and open it in a browser.
 *
 * On-demand by design: nothing is collected in the background and no server runs.
 * The command scans the local session files, writes one self-contained HTML file
 * (no external assets, no network) and hands it to the OS default browser.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateUsageDashboard } from "./build.ts";

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
        const result = await generateUsageDashboard();
        const { stats } = result;
        ctx.ui.notify(
          [
            `用量仪表盘已生成（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`,
            `${stats.records.toLocaleString()} 条记录 · ${stats.sessions} 个会话 · ${stats.projects} 个项目`,
            `成本 $${stats.cost.toFixed(2)} · fresh token ${(stats.freshTokens / 1e6).toFixed(1)}M · 缓存读取 ${(stats.cacheReadTokens / 1e6).toFixed(1)}M`,
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
