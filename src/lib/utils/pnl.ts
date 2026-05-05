import type { Trade } from "@/types/trade";
import { getTodayAnchor } from "./date";

// ---- Currency configuration ----

let activeCurrency = "USD";
let conversionRate = 1;

export function setActiveCurrency(currency: string, rate = 1) {
  activeCurrency = currency;
  conversionRate = currency === "USD" ? 1 : rate;
}

export function getActiveCurrency(): string {
  return activeCurrency;
}

const currencyFormatter = new Map<string, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string): Intl.NumberFormat {
  let fmt = currencyFormatter.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFormatter.set(currency, fmt);
  }
  return fmt;
}

export function getCurrencySymbol(): string {
  const fmt = getCurrencyFormatter(activeCurrency);
  const parts = fmt.formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? "$";
}

/**
 * Sum the `realized_pnl` field across rows, treating null/missing as 0.
 * Centralised because at least five sites had this exact reducer inline:
 * dashboard portfolio stats, FTMO gauges, today/total stats, AI prompts.
 */
export function sumRealizedPnl(rows: readonly { realized_pnl: number | null }[]): number {
  return rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
}

/** Sum the `unrealized_pnl` field across rows, treating null/missing as 0. */
export function sumUnrealizedPnl(rows: readonly { unrealized_pnl: number | null }[]): number {
  return rows.reduce((s, r) => s + (r.unrealized_pnl ?? 0), 0);
}

export function calculateRealizedPnl(trade: {
  side: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  commission: number;
  fees: number;
  status: string;
}): number | null {
  if (trade.status !== "closed" || trade.exit_price == null) return null;

  const gross =
    trade.side === "long"
      ? (trade.exit_price - trade.entry_price) * trade.quantity
      : (trade.entry_price - trade.exit_price) * trade.quantity;

  return gross - (trade.commission ?? 0) - (trade.fees ?? 0);
}

export function calculatePnlPercent(trade: {
  side: string;
  entry_price: number;
  exit_price: number | null;
  status: string;
}): number | null {
  if (trade.status !== "closed" || trade.exit_price == null) return null;
  if (trade.entry_price === 0) return null;

  return trade.side === "long"
    ? ((trade.exit_price - trade.entry_price) / trade.entry_price) * 100
    : ((trade.entry_price - trade.exit_price) / trade.entry_price) * 100;
}

export function formatPnl(value: number | null): string {
  if (value == null) return "—";
  const converted = value * conversionRate;
  const sign = converted >= 0 ? "+" : "-";
  const formatted = getCurrencyFormatter(activeCurrency).format(Math.abs(converted));
  return `${sign}${formatted}`;
}

export function formatPnlPercent(value: number | null): string {
  if (value == null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function pnlColorClass(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  return value >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]";
}

export function formatCurrency(value: number): string {
  return getCurrencyFormatter(activeCurrency).format(value * conversionRate);
}

export function formatQuantity(value: number): string {
  return value % 1 === 0 ? value.toString() : value.toFixed(4);
}

/**
 * Format an instrument PRICE for display — never apply the display-currency
 * converter, never prepend a currency symbol. Exchange rates aren't currency
 * values; "GBP/JPY 215.808" means "1 GBP = 215.808 JPY", not "£215.81".
 *
 * Decimal precision matches broker conventions: 3 dp for JPY-quoted forex
 * (where 1 pip = 0.01), 5 dp for other forex pairs (1 pip = 0.0001), and
 * 2 dp for everything else (equities, commodities, crypto).
 */
export function formatPriceValue(symbol: string, price: number | null | undefined): string {
  if (price == null) return "\u2014";
  const upper = symbol.toUpperCase();
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(upper)) {
    return upper.endsWith("/JPY") ? price.toFixed(3) : price.toFixed(5);
  }
  return price.toFixed(2);
}

/**
 * Render the gap between our paper-side price and the broker's actual fill
 * as a signed pip count (forex) or percentage (everything else). Returns null
 * when there's nothing to show (no broker price, identical prices, or both
 * prices missing). Currency-neutral — operates on raw stored prices, NOT
 * the display-currency-converted values.
 */
export function formatBrokerDivergence(
  symbol: string,
  paperPrice: number | null | undefined,
  brokerPrice: number | null | undefined
): string | null {
  if (paperPrice == null || brokerPrice == null) return null;
  const delta = brokerPrice - paperPrice;
  if (Math.abs(delta) < 1e-9) return null;

  // JPY-quoted forex pairs use 0.01 per pip; other forex pairs use 0.0001.
  const upper = symbol.toUpperCase();
  const isForex = /^[A-Z]{3}\/[A-Z]{3}$/.test(upper);
  if (isForex) {
    const pip = upper.endsWith("/JPY") ? 0.01 : 0.0001;
    const pips = delta / pip;
    const sign = pips >= 0 ? "+" : "";
    return `${sign}${pips.toFixed(1)} pips`;
  }
  const pct = (delta / paperPrice) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function calculateUnrealizedPnl(
  side: "long" | "short",
  entryPrice: number,
  currentPrice: number,
  quantity: number
): number {
  return side === "long"
    ? (currentPrice - entryPrice) * quantity
    : (entryPrice - currentPrice) * quantity;
}

const RELATIVE_TIME_UNITS: [number, string][] = [
  [60, "s"],
  [3600, "m"],
  [86400, "h"],
  [604800, "d"],
  [2592000, "w"],
  [31536000, "mo"],
];

export function formatRelativeTime(dateString: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 10) return "just now";

  for (let i = RELATIVE_TIME_UNITS.length - 1; i >= 0; i--) {
    const [threshold, unit] = RELATIVE_TIME_UNITS[i];
    if (seconds >= threshold) {
      const value = Math.floor(seconds / threshold);
      return `${value}${unit} ago`;
    }
  }
  return `${seconds}s ago`;
}

export function getTradeStats(trades: Trade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realized_pnl != null && t.realized_pnl > 0);
  const totalPnl = sumRealizedPnl(closed);

  // Today's P&L
  const today = getTodayAnchor().utcDate;
  const todayPnl = sumRealizedPnl(closed.filter((t) => t.exit_date?.startsWith(today)));

  // Current streak
  const sortedClosed = [...closed]
    .filter((t) => t.realized_pnl != null)
    .sort((a, b) => new Date(b.exit_date!).getTime() - new Date(a.exit_date!).getTime());
  let streak = 0;
  if (sortedClosed.length > 0) {
    const firstIsWin = sortedClosed[0].realized_pnl! > 0;
    for (const t of sortedClosed) {
      if (t.realized_pnl! > 0 === firstIsWin) {
        streak++;
      } else {
        break;
      }
    }
    if (!firstIsWin) {
      streak = -streak;
    }
  }

  // Best & worst
  const pnls = closed.filter((t) => t.realized_pnl != null).map((t) => t.realized_pnl!);
  const bestTrade = pnls.length > 0 ? Math.max(...pnls) : 0;
  const worstTrade = pnls.length > 0 ? Math.min(...pnls) : 0;

  return {
    totalTrades: trades.length,
    openTrades: trades.length - closed.length,
    closedTrades: closed.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalPnl,
    todayPnl,
    streak,
    bestTrade,
    worstTrade,
  };
}
