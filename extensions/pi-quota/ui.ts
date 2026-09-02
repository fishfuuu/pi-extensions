import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export type QuotaRow = { label: string; usedPct: number; reset?: string };
export type MixRow = { name: string; requests: number };
export type QuotaBalance = { currency: string; amount: string; available: boolean };
export type QuotaCard = {
  providerId: string;
  title: string;
  error?: string;
  rows: QuotaRow[];
  plan?: string;
  extras?: string[];
  mix?: MixRow[];
  mixWeekly?: boolean;
  balances?: QuotaBalance[];
};

export type TightestQuota = {
  label: string;
  remainingPercent: number;
  reset?: string;
};

export type NavState = {
  selectedIndex: number;
  expanded: Set<string>;
};

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

export function remainingOf(usedPct: number): number {
  return Math.min(100, Math.max(0, 100 - usedPct));
}

export function expandableIds(cards: QuotaCard[]): string[] {
  return cards.filter((c) => c.mix && c.mix.length > 0).map((c) => c.providerId);
}

export function tightestQuota(card: QuotaCard): TightestQuota | undefined {
  if (card.error || card.rows.length === 0) return undefined;
  let best = card.rows[0];
  let bestLeft = remainingOf(best.usedPct);
  for (const row of card.rows) {
    const left = remainingOf(row.usedPct);
    if (left < bestLeft) {
      best = row;
      bestLeft = left;
    }
  }
  return {
    label: best.label,
    remainingPercent: bestLeft,
    reset: best.reset,
  };
}

export function applyNav(state: NavState, action: "up" | "down" | "enter" | "m", ids: string[]): NavState {
  const expanded = new Set(state.expanded);
  if (ids.length === 0) return { selectedIndex: 0, expanded };
  const n = ids.length;
  let selectedIndex = ((state.selectedIndex % n) + n) % n;
  if (action === "up") selectedIndex = (selectedIndex - 1 + n) % n;
  if (action === "down") selectedIndex = (selectedIndex + 1) % n;
  if (action === "enter") {
    const id = ids[selectedIndex];
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }
  if (action === "m") {
    const allOpen = ids.every((id) => expanded.has(id));
    if (allOpen) {
      for (const id of ids) expanded.delete(id);
    } else {
      for (const id of ids) expanded.add(id);
    }
  }
  return { selectedIndex, expanded };
}

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

function balanceOk(b: QuotaBalance): boolean {
  const n = Number(b.amount);
  return b.available && Number.isFinite(n) && n > 0;
}

function balanceWidget(card: QuotaCard): string {
  const list = card.balances ?? [];
  if (list.length === 0) return `${card.title} · --`;
  if (!list.some(balanceOk)) return `${card.title} · unavailable`;
  return `${card.title} · ${list.map((b) => `${b.currency} ${b.amount}`).join(" · ")}`;
}

export function compactWidgetLines(cards: QuotaCard[]): string[] {
  return cards.map((c) => {
    if (c.error) return `${c.title} · ${c.error}`;
    if (c.balances && c.balances.length > 0) return balanceWidget(c);
    const tight = tightestQuota(c);
    if (!tight) return `${c.title} · --`;
    const pct = `${tight.label} ${tight.remainingPercent.toFixed(0)}% left`;
    return tight.reset ? `${c.title} · ${pct} · ${tight.reset}` : `${c.title} · ${pct}`;
  });
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
