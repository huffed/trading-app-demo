import type { Trade } from "@/types/trade";

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
  const sign = converted >= 0 ? "+" : "";
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
  const totalPnl = closed.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0);

  // Today's P&L
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = closed
    .filter((t) => t.exit_date?.startsWith(today))
    .reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0);

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
