"use client";

import { useEffect, useState } from "react";
import {
  getPositionLiveQuote,
  getPositionMaeMfe,
  type PositionLiveQuote,
  type PositionMaeMfe,
} from "@/app/(dashboard)/algorithms/position-stats-actions";
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
    second: "2-digit",
  });
}

function holdDuration(opened: string, closed: string | null): string {
  const start = new Date(opened).getTime();
  const end = closed ? new Date(closed).getTime() : Date.now();
  const mins = Math.round((end - start) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

function pnlNet(t: BacktestTradeRow): number {
  if (t.status === "closed") return t.realized_pnl ?? 0;
  return t.broker_unrealized_pnl ?? t.unrealized_pnl;
}

function pnlGross(t: BacktestTradeRow): number {
  if (t.status === "closed") return t.realized_pnl ?? 0;
  return t.unrealized_pnl;
}

function PriceSection({
  t,
  liveQuote,
}: {
  t: BacktestTradeRow;
  liveQuote: PositionLiveQuote | null;
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Price</h3>
      <DataRow label="Type" value={t.side === "long" ? "BUY" : "SELL"} />
      <DataRow label="Open" value={formatPriceValue(t.ticker, t.entry_price)} />
      <DataRow
        label="Close"
        value={t.exit_price != null ? formatPriceValue(t.ticker, t.exit_price) : "—"}
      />
      {liveQuote && (
        <>
          <DataRow label="Bid" value={formatPriceValue(t.ticker, liveQuote.bid)} />
          <DataRow label="Ask" value={formatPriceValue(t.ticker, liveQuote.ask)} />
          <DataRow label="Spread" value={liveQuote.spread_pips.toFixed(1) + " pips"} />
        </>
      )}
    </section>
  );
}

function ProtectionSection({ t }: { t: BacktestTradeRow }) {
  const sl = t.stop_loss_price;
  const tp = t.take_profit_price;
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Protection</h3>
      <DataRow label="SL" value={sl != null ? formatPriceValue(t.ticker, sl) : "—"} />
      <DataRow
        label="SL pips"
        value={t.sl_pips != null ? t.sl_pips.toFixed(1) : "—"}
      />
      <DataRow label="TP" value={tp != null ? formatPriceValue(t.ticker, tp) : "—"} />
      <DataRow
        label="TP pips"
        value={t.tp_pips != null ? t.tp_pips.toFixed(1) : "—"}
      />
    </section>
  );
}

function ResultsSection({ t }: { t: BacktestTradeRow }) {
  const gross = pnlGross(t);
  const net = pnlNet(t);
  const swapAndComm = net - gross;
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Results</h3>
      <DataRow
        label="Gross P&L"
        value={<span className={pnlColorClass(gross)}>{formatPnl(gross)}</span>}
      />
      {Math.abs(swapAndComm) > 0.01 && (
        <DataRow
          label="Swap + Comm."
          value={<span className={pnlColorClass(swapAndComm)}>{formatPnl(swapAndComm)}</span>}
        />
      )}
      <DataRow
        label="Net P&L"
        value={<span className={pnlColorClass(net)}>{formatPnl(net)}</span>}
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
      <DataRow label="Open" value={fmtTime(t.opened_at)} />
      <DataRow label="Close" value={fmtTime(t.closed_at)} />
      <DataRow label="Hold" value={holdDuration(t.opened_at, t.closed_at)} />
      {t.exit_reason && (
        <DataRow
          label="Exit reason"
          value={EXIT_REASON_LABELS[t.exit_reason] ?? t.exit_reason}
        />
      )}
    </section>
  );
}

function StatsSection({
  t,
  maeMfe,
}: {
  t: BacktestTradeRow;
  maeMfe: PositionMaeMfe | null;
}) {
  if (!maeMfe) {
    return (
      <section className="space-y-1">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Trade stats</h3>
        <p className="text-xs text-muted-foreground">Not enough cached bars to compute MAE/MFE.</p>
      </section>
    );
  }
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Trade stats</h3>
      <DataRow label="MAE pips" value={maeMfe.mae_pips.toFixed(1)} />
      <DataRow label="MAE price" value={formatPriceValue(t.ticker, maeMfe.mae_price)} />
      <DataRow label="MAE at" value={fmtTime(maeMfe.mae_at)} />
      <DataRow label="MFE pips" value={maeMfe.mfe_pips.toFixed(1)} />
      <DataRow label="MFE price" value={formatPriceValue(t.ticker, maeMfe.mfe_price)} />
      <DataRow label="MFE at" value={fmtTime(maeMfe.mfe_at)} />
    </section>
  );
}

/** Component mounts fresh per trade id (parent uses key={trade.id}),
 *  so the data fetch effect runs exactly once per mount and never
 *  needs to reset state for a new trade. */
export function TradeDetail({ trade }: { trade: BacktestTradeRow }) {
  const [maeMfe, setMaeMfe] = useState<PositionMaeMfe | null>(null);
  const [liveQuote, setLiveQuote] = useState<PositionLiveQuote | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPositionMaeMfe(trade.id).then((r) => {
      if (!cancelled && r.success) setMaeMfe(r.data);
    });
    if (trade.status === "open") {
      getPositionLiveQuote(trade.id).then((r) => {
        if (!cancelled && r.success) setLiveQuote(r.data);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [trade.id, trade.status]);

  return (
    <Surface elevation="low" className="p-4 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {trade.ticker} · {trade.status}
        </p>
        <p className="text-sm font-semibold tabular-nums mt-0.5">
          {trade.side === "long" ? "BUY" : "SELL"} {trade.quantity}
        </p>
      </div>
      <PriceSection t={trade} liveQuote={liveQuote} />
      <ProtectionSection t={trade} />
      <ResultsSection t={trade} />
      <TimeSection t={trade} />
      <StatsSection t={trade} maeMfe={maeMfe} />
    </Surface>
  );
}
