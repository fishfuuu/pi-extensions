import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  remainingOf,
  expandableIds,
  tightestQuota,
  applyNav,
  balanceOk,
  type QuotaRow,
  type MixRow,
  type QuotaBalance,
  type QuotaCard,
  type TightestQuota,
  type NavState,
} from "./core.ts";

export type { QuotaRow, MixRow, QuotaBalance, QuotaCard, TightestQuota, NavState };

/** token-burden overlay path: raw SGR, including 38;2 truecolor. Pi Web parses this. */
function sgr(code: string, text: string): string {
  if (!code) return text;
  return `\u001B[${code}m${text}\u001B[0m`;
}

function dim(text: string): string {
  return `\u001B[2m${text}\u001B[22m`;
}

function bold(text: string): string {
  return `\u001B[1m${text}\u001B[22m`;
}

const COLOR = {
  success: "38;2;137;210;129",
  warning: "38;2;254;188;56",
  error: "38;2;220;80;80",
  accent: "38;2;23;143;185",
  mix2: "38;2;178;129;214",
} as const;

function pressureCode(remaining: number): string {
  if (remaining <= 0 || remaining < 15) return COLOR.error;
  if (remaining <= 40) return COLOR.warning;
  return COLOR.success;
}

/** Bar length = remaining %. Color = remaining pressure. Number = remaining %. */
function remainingBar(remaining: number, width: number): string {
  const r = Math.min(100, Math.max(0, remaining));
  const w = Math.max(10, Math.min(22, width));
  const filled = Math.round((r / 100) * w);
  return sgr(pressureCode(r), "█".repeat(filled)) + dim("░".repeat(w - filled));
}

function renderPanel(cards: QuotaCard[], width: number, nav: NavState): string[] {
  const ids = expandableIds(cards);
  const selectedId = ids.length ? ids[nav.selectedIndex] : undefined;
  const inner = Math.max(40, Math.min(76, width - 4));
  const barW = Math.max(10, inner - 28);
  const lines: string[] = [];
  const hr = dim("─".repeat(inner));
  lines.push(bold("QUOTA"));
  lines.push(hr);

  for (const card of cards) {
    const focusable = Boolean(card.mix && card.mix.length > 0);
    const selected = focusable && card.providerId === selectedId;
    const mark = selected ? "› " : "  ";
    lines.push(`${mark}${bold(card.title)}`);
    if (card.error) {
      lines.push(`  ${sgr(COLOR.error, card.error)}`);
      lines.push("");
      continue;
    }
    if (card.balances && card.balances.length > 0) {
      for (const b of card.balances) {
        const ok = balanceOk(b);
        const amt = sgr(ok ? COLOR.success : COLOR.error, `${b.currency} ${b.amount}`);
        lines.push(`  Balance  ${amt}`);
        lines.push(`           ${ok ? "available" : "unavailable"}`);
      }
    }
    for (const row of card.rows) {
      const left = remainingOf(row.usedPct);
      const num = sgr(pressureCode(left), `${left.toFixed(1)}% left`);
      lines.push(`  ${row.label.padEnd(7)} ${remainingBar(left, barW)}  ${num}`);
      if (row.reset) lines.push(`          Reset  ${row.reset}`);
    }
    if (card.plan) lines.push(`          Plan   ${card.plan}`);
    for (const extra of card.extras ?? []) lines.push(`          ${extra}`);
    if (card.mix && card.mix.length > 0) {
      const open = nav.expanded.has(card.providerId);
      const kind = card.mixWeekly ? "week" : "session";
      lines.push(`  ${open ? "▾" : "▸"} Models this ${kind} · estimated by requests`);
      if (open) {
        const total = card.mix.reduce((s, m) => s + m.requests, 0) || 1;
        card.mix.forEach((m, i) => {
          const share = (m.requests / total) * 100;
          const fill = Math.max(1, Math.round(share / 10));
          const color = i === 0 ? COLOR.accent : COLOR.mix2;
          const bar = sgr(color, "█".repeat(fill)) + dim("░".repeat(Math.max(0, 10 - fill)));
          lines.push(`     ${m.name.padEnd(16)} ${bar}  ${share.toFixed(1)}% · ${m.requests} req`);
        });
      }
    }
    lines.push("");
  }
  if (cards.some((c) => c.mix && c.mix.length > 0)) {
    lines.push(dim("Model mix reflects request count, not quota consumption."));
  }
  lines.push(dim("↑↓ select · Enter toggle · m toggle all · Esc close"));
  return lines;
}

export async function showQuotaPanel(ctx: ExtensionCommandContext, cards: QuotaCard[]): Promise<boolean> {
  let opened = false;
  const ids = expandableIds(cards);
  await ctx.ui.custom<null>(
    (tui, _theme, _kb, done) => {
      opened = true;
      let nav: NavState = { selectedIndex: 0, expanded: new Set() };
      const paint = () => tui.requestRender();
      return {
        render: (width: number) => renderPanel(cards, width, nav),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape") || data === "q" || data === "Q") {
            done(null);
            return;
          }
          if (matchesKey(data, "up")) {
            nav = applyNav(nav, "up", ids);
            paint();
            return;
          }
          if (matchesKey(data, "down")) {
            nav = applyNav(nav, "down", ids);
            paint();
            return;
          }
          if (matchesKey(data, "enter")) {
            nav = applyNav(nav, "enter", ids);
            paint();
            return;
          }
          if (data === "m" || data === "M") {
            nav = applyNav(nav, "m", ids);
            paint();
          }
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: "80%" } },
  );
  return opened;
}
