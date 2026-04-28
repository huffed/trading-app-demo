"use client";

import { pnlInUsd } from "@/lib/constants/markets";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

interface BrokerPnlReading {
  value: number;
  /** "synced" = broker-reported number from manage-positions cron.
   *  "estimated" = computed from broker_fill_price and current price
   *  (Twelve Data mid). Estimated is ~half-spread + any commission/swap
   *  optimistic vs the broker's actual number. */
  source: "synced" | "estimated";
}

/**
 * Best available broker-side P&L for a position. Prefers the cached
 * broker_unrealized_pnl that manage-positions writes from the broker
 * adapter (includes spread, commission, swap — what FTMO/MT5 actually
 * shows). Falls back to a Twelve-Data-based estimate when no synced
 * value exists yet (e.g. position just opened, broker fetch hasn't run).
 */
function readBrokerPnl(pos: PaperPosition): BrokerPnlReading | null {
  if (pos.status !== "closed" && pos.broker_unrealized_pnl != null) {
    return { value: pos.broker_unrealized_pnl, source: "synced" };
  }
  if (pos.broker_fill_price == null) return null;
  if (pos.status === "closed") {
    if (pos.broker_close_price == null) return null;
    return {
      value: pnlInUsd(
        pos.ticker,
        pos.side,
        pos.broker_fill_price,
        pos.broker_close_price,
        pos.quantity
      ),
      source: "synced",
    };
  }
  if (pos.current_price == null) return null;
  return {
    value: pnlInUsd(
      pos.ticker,
      pos.side,
      pos.broker_fill_price,
      pos.current_price,
      pos.quantity
    ),
    source: "estimated",
  };
}

export function PnlCell({ pos }: { pos: PaperPosition }) {
  const paperPnl = pos.status === "closed" ? (pos.realized_pnl ?? 0) : pos.unrealized_pnl;
  const broker = readBrokerPnl(pos);
  const brokerLabel = broker?.source === "synced" ? "broker" : "broker ~";
  const brokerTitle =
    broker?.source === "synced"
      ? "Broker-reported P&L (includes spread, commission, swap). Synced every ~5 min from the manage-positions cron."
      : "Estimated broker P&L using Twelve Data mid-quote — half-spread optimistic vs the broker's actual number. Will refresh once manage-positions ticks.";
  return (
    <div className="text-right">
      <div className={`tabular-nums font-medium ${pnlColorClass(paperPnl)}`}>
        {formatPnl(paperPnl)}
      </div>
      {broker !== null && (
        <div
          className={`text-[10px] tabular-nums ${pnlColorClass(broker.value)}`}
          title={brokerTitle}
        >
          {brokerLabel} {formatPnl(broker.value)}
        </div>
      )}
    </div>
  );
}
