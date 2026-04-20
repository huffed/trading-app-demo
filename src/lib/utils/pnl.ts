import type { Trade } from "@/types/trade";

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
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
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
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQuantity(value: number): string {
  return value % 1 === 0 ? value.toString() : value.toFixed(4);
}

export function getTradeStats(trades: Trade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realized_pnl != null && t.realized_pnl > 0);
  const totalPnl = closed.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0);

  return {
    totalTrades: trades.length,
    openTrades: trades.length - closed.length,
    closedTrades: closed.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalPnl,
  };
}
