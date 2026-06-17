"use client";

import type { BacktestTradeRow } from "@/app/(dashboard)/backtest/actions";
import { DataRow } from "@/components/ui/data-row";
import { Surface } from "@/components/ui/surface";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import { formatPnl, formatPriceValue, pnlColorClass } from "@/lib/utils/pnl";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function holdDuration(opened: string, closed: string): string {
  const start = new Date(opened).getTime();
  const end = new Date(closed).getTime();
  const mins = Math.round((end - start) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

function PriceSection({ t }: { t: BacktestTradeRow }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Price</h3>
      <DataRow label="Type" value={t.side === "long" ? "BUY" : "SELL"} />
      <DataRow label="Open" value={formatPriceValue(t.ticker, t.entry_price)} />
      <DataRow label="Close" value={formatPriceValue(t.ticker, t.exit_price)} />
    </section>
  );
}

function ResultsSection({ t }: { t: BacktestTradeRow }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Results</h3>
      <DataRow
        label="P&L"
        value={<span className={pnlColorClass(t.pnl)}>{formatPnl(t.pnl)}</span>}
      />
      {t.r_multiple != null && (
        <DataRow
          label="R-multiple"
          value={
            <span className={pnlColorClass(t.r_multiple)}>
              {t.r_multiple >= 0 ? "+" : ""}
              {t.r_multiple.toFixed(2)}R
            </span>
          }
        />
      )}
    </section>
  );
}

function TimeSection({ t }: { t: BacktestTradeRow }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Time</h3>
      <DataRow label="Open" value={fmtTime(t.entry_date)} />
      <DataRow label="Close" value={fmtTime(t.exit_date)} />
      <DataRow label="Hold" value={holdDuration(t.entry_date, t.exit_date)} />
      {t.exit_reason && (
        <DataRow
          label="Exit reason"
          value={EXIT_REASON_LABELS[t.exit_reason] ?? t.exit_reason}
        />
      )}
    </section>
  );
}

/** Backtest-trade detail panel. Compared to live paper positions, the
 *  backtest engine doesn't surface per-trade SL/TP/MAE/MFE in its current
 *  shape — those columns would all be null. Show only what we actually
 *  persist: price / P&L / R-multiple / timing. Engine upgrades to surface
 *  SL/TP + MAE/MFE per trade can extend this without a schema change. */
export function TradeDetail({ trade }: { trade: BacktestTradeRow }) {
  return (
    <Surface elevation="low" className="p-4 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {trade.ticker} · backtest
        </p>
        <p className="text-sm font-semibold tabular-nums mt-0.5">
          {trade.side === "long" ? "BUY" : "SELL"}
        </p>
      </div>
      <PriceSection t={trade} />
      <ResultsSection t={trade} />
      <TimeSection t={trade} />
    </Surface>
  );
}
