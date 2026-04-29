"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePositionLiveQuote, usePositionMaeMfe } from "@/hooks/use-position-stats";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import { getInstrumentMeta } from "@/lib/constants/markets";
import { formatPnl, formatPriceValue, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

function formatDuration(openIso: string, closeIso?: string | null): string {
  const start = new Date(openIso).getTime();
  const end = closeIso ? new Date(closeIso).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return `${days}d ${remHr}h`;
}

function pipsBetween(symbol: string, a: number, b: number): number {
  const pipSize = getInstrumentMeta(symbol)?.pipSize ?? 0.0001;
  return (a - b) / pipSize;
}

function StatRow({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className ?? ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-1.5 tabular-nums">
        <span>{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

function StatsPanel({ pos }: { pos: PaperPosition }) {
  const isOpen = pos.status === "open";
  // Skip live quote for closed positions — exit price is the relevant
  // anchor; live bid/ask doesn't tell you anything about the trade.
  const { data: quote, isLoading: quoteLoading } = usePositionLiveQuote(pos.id, isOpen);
  const { data: maeMfe, isLoading: maeLoading } = usePositionMaeMfe(pos.id, true);

  const isLong = pos.side === "long";
  const slPips =
    pos.stop_loss_price != null
      ? pipsBetween(pos.ticker, pos.stop_loss_price, pos.entry_price)
      : null;
  const tpPips =
    pos.take_profit_price != null
      ? pipsBetween(pos.ticker, pos.take_profit_price, pos.entry_price)
      : null;
  const grossPnl = isOpen
    ? pos.broker_unrealized_pnl ?? pos.unrealized_pnl ?? 0
    : pos.realized_pnl ?? 0;

  return (
    <div className="grid gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Price
        </div>
        <StatRow label="Open" value={formatPriceValue(pos.ticker, pos.entry_price)} />
        {!isOpen && (
          <StatRow
            label="Close"
            value={formatPriceValue(
              pos.ticker,
              pos.broker_close_price ?? pos.exit_price ?? null
            )}
          />
        )}
        {isOpen && quoteLoading && !quote && (
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        )}
        {isOpen && quote && (
          <>
            <StatRow label="Bid" value={formatPriceValue(pos.ticker, quote.bid)} />
            <StatRow label="Ask" value={formatPriceValue(pos.ticker, quote.ask)} />
            <StatRow
              label="Spread"
              value={formatPriceValue(pos.ticker, quote.spread)}
              hint={`${quote.spread_pips.toFixed(1)} pips`}
            />
          </>
        )}
        {isOpen && !quoteLoading && !quote && (
          <p className="text-xs text-muted-foreground italic">Live quote unavailable</p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Trade Protection
        </div>
        <StatRow
          label="SL"
          value={formatPriceValue(pos.ticker, pos.stop_loss_price)}
          hint={slPips != null ? `${slPips.toFixed(0)} pips` : undefined}
        />
        <StatRow
          label="TP"
          value={formatPriceValue(pos.ticker, pos.take_profit_price)}
          hint={tpPips != null ? `${tpPips > 0 ? "+" : ""}${tpPips.toFixed(0)} pips` : undefined}
        />
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Results
        </div>
        <StatRow
          label="Gross"
          value={<span className={pnlColorClass(grossPnl)}>{formatPnl(grossPnl)}</span>}
        />
        <StatRow label="Comm." value="$0.00" />
        <StatRow label="Swap" value="$0.00" />
        <StatRow
          label="Net"
          value={
            <span className={`font-medium ${pnlColorClass(grossPnl)}`}>
              {formatPnl(grossPnl)}
            </span>
          }
        />
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Time
        </div>
        <StatRow
          label="Open"
          value={new Date(pos.opened_at).toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        />
        {!isOpen && pos.closed_at && (
          <StatRow
            label="Close"
            value={new Date(pos.closed_at).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          />
        )}
        <StatRow label="Duration" value={formatDuration(pos.opened_at, pos.closed_at)} />
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Trade Stats
        </div>
        {maeLoading && !maeMfe && (
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        )}
        {maeMfe && (
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <StatRow
              label="MAE"
              value={
                <span className="text-[var(--loss)]">
                  -{maeMfe.mae_pips.toFixed(1)} pips
                </span>
              }
              hint={`${formatPriceValue(pos.ticker, maeMfe.mae_price)} · ${new Date(
                maeMfe.mae_at
              ).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
            />
            <StatRow
              label="MFE"
              value={
                <span className="text-[var(--profit)]">
                  +{maeMfe.mfe_pips.toFixed(1)} pips
                </span>
              }
              hint={`${formatPriceValue(pos.ticker, maeMfe.mfe_price)} · ${new Date(
                maeMfe.mfe_at
              ).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
            />
          </div>
        )}
        {!maeLoading && !maeMfe && (
          <p className="text-xs text-muted-foreground italic">
            Not enough cached bars to compute extremes yet
          </p>
        )}
        {maeMfe && (
          <p className="text-[10px] text-muted-foreground italic">
            {`From ${maeMfe.bars_examined} bars at the algorithm's timeframe; intraday extremes between bars not captured. Side: ${isLong ? "long" : "short"}.`}
          </p>
        )}
      </div>
    </div>
  );
}

export function PositionDetailCard({
  pos,
  onClose,
}: {
  pos: PaperPosition;
  /** Manual close handler. Omit / no-op for closed positions. */
  onClose?: (pos: PaperPosition) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = pos.status === "open";
  const grossPnl = isOpen
    ? pos.broker_unrealized_pnl ?? pos.unrealized_pnl ?? 0
    : pos.realized_pnl ?? 0;
  const sideLabel = pos.side === "long" ? "BUY" : "SELL";
  const sideClass =
    pos.side === "long"
      ? "bg-[var(--profit)]/10 text-[var(--profit)]"
      : "bg-[var(--loss)]/10 text-[var(--loss)]";
  const exitReasonLabel = !isOpen
    ? EXIT_REASON_LABELS[pos.exit_reason ?? ""] ?? pos.exit_reason
    : null;

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
      >
        <span className="font-medium tabular-nums">{pos.ticker}</span>
        <Badge variant="secondary" className={`text-[10px] ${sideClass}`}>
          {sideLabel}
        </Badge>
        <span className={`tabular-nums text-sm ${pnlColorClass(grossPnl)}`}>
          {formatPnl(grossPnl)}
        </span>
        {exitReasonLabel && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {exitReasonLabel}
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {formatDuration(pos.opened_at, pos.closed_at)}
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t bg-muted/20">
          <StatsPanel pos={pos} />
          {isOpen && onClose && (
            <div className="flex justify-end px-4 pb-3">
              <Button size="sm" variant="outline" onClick={() => onClose(pos)}>
                Close position
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
