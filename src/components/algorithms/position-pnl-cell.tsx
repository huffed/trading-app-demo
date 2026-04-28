"use client";

import { pnlInUsd } from "@/lib/constants/markets";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

/**
 * P&L using the actual broker fill price (and broker close price when
 * closed) instead of the paper entry/exit. Reflects what FTMO / MT5
 * actually shows on its side. Returns null for paper-only positions
 * (no broker mirror) — UI hides the second line in that case.
 */
function computeBrokerPnl(pos: PaperPosition): number | null {
  if (pos.broker_fill_price == null) return null;
  if (pos.status === "closed") {
    if (pos.broker_close_price == null) return null;
    return pnlInUsd(
      pos.ticker,
      pos.side,
      pos.broker_fill_price,
      pos.broker_close_price,
      pos.quantity
    );
  }
  if (pos.current_price == null) return null;
  return pnlInUsd(
    pos.ticker,
    pos.side,
    pos.broker_fill_price,
    pos.current_price,
    pos.quantity
  );
}

export function PnlCell({ pos }: { pos: PaperPosition }) {
  const paperPnl = pos.status === "closed" ? (pos.realized_pnl ?? 0) : pos.unrealized_pnl;
  const brokerPnl = computeBrokerPnl(pos);
  return (
    <div className="text-right">
      <div className={`tabular-nums font-medium ${pnlColorClass(paperPnl)}`}>
        {formatPnl(paperPnl)}
      </div>
      {brokerPnl !== null && (
        <div
          className={`text-[10px] tabular-nums ${pnlColorClass(brokerPnl)}`}
          title="P&L using broker fill price — what FTMO/MT5 actually shows. Differs from paper P&L by the entry/exit slippage."
        >
          broker {formatPnl(brokerPnl)}
        </div>
      )}
    </div>
  );
}
