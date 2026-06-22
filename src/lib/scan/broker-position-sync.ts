/**
 * Broker-position sync helpers — invoked from the manage-positions tick to
 * pull broker-side unrealized P&L back onto paper rows AND detect positions
 * that the broker has stopped reporting (broker-side closes that bypass our
 * exit logic).
 *
 * Extracted from `scan/manage.ts` on 2026-06-22 (CB.H1 + CB.T1 hybrid pass)
 * so the sync logic can be unit-tested independently of the manage-cron
 * orchestrator. Behaviour is byte-equivalent to the pre-extraction inline
 * implementation.
 *
 * Two exports:
 *   - `syncBrokerUnrealizedPnl` — for every mirrored open position, copy
 *     the broker's current unrealized profit onto `broker_unrealized_pnl`.
 *     Missing-from-broker positions are delegated to the reconciler below.
 *   - `reconcileMissingBrokerPosition` — when a paper row's broker mirror
 *     has disappeared, try to fetch the realised close from the broker's
 *     history; if found, close the paper row with the actual fill +
 *     classified exit_reason (SL / TP / manual via ±0.1% tolerance). No-op
 *     on adapters without `fetchClosedDealForPosition` (e.g. cTrader proto-
 *     stream only).
 */
import { logger } from "@/lib/logger";
import type { PaperPosition } from "@/types/position";
import { logActivity } from "./helpers";
import { resolveBrokerContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Walk the mirrored open positions and copy each broker side's current
 * unrealized profit back onto the paper row. Best-effort: broker-fetch
 * failures leave the cached value stale, which is preferable to nulling
 * out a recent good value just because one tick had a network blip.
 */
export async function syncBrokerUnrealizedPnl(
  supabase: SupabaseClient,
  brokerCtx: Awaited<ReturnType<typeof resolveBrokerContext>>,
  positions: PaperPosition[]
): Promise<void> {
  if (!brokerCtx) return;
  const mirrored = positions.filter((p) => p.broker_position_id);
  if (mirrored.length === 0) return;
  let brokerPositions: Awaited<ReturnType<typeof brokerCtx.adapter.fetchPositions>>;
  try {
    brokerPositions = await brokerCtx.adapter.fetchPositions(brokerCtx.conn);
  } catch (err) {
    logger.warn(
      "manage-positions",
      "broker fetchPositions failed, leaving broker_unrealized_pnl stale",
      err instanceof Error ? err.message : err
    );
    return;
  }
  const byId = new Map(brokerPositions.map((p) => [String(p.id), p]));
  const syncedAt = new Date().toISOString();
  for (const paper of mirrored) {
    const broker = byId.get(String(paper.broker_position_id));
    if (!broker) {
      // Broker stopped reporting this position. Either (a) it was closed
      // outside our exit logic — typically operator clicked close in the
      // broker UI — or (b) MetaApi has lag and the position will reappear
      // in a moment. Try to fetch the realised close from the broker's
      // history; if found, write it back. If not (lag or unsupported
      // adapter), leave the row alone and retry on the next tick.
      await reconcileMissingBrokerPosition(supabase, brokerCtx, paper);
      continue;
    }
    await supabase
      .from("paper_positions")
      .update({
        broker_unrealized_pnl: Number(broker.profit ?? 0),
        broker_pnl_synced_at: syncedAt,
      })
      .eq("id", paper.id);
  }
}

/**
 * Try to find the realised close of a paper position whose broker mirror
 * stopped reporting. Pulled out so the same logic is reusable from
 * scripts/reconcile-broker-close.ts. No-op when the adapter doesn't
 * implement fetchClosedDealForPosition (cTrader streams deals only).
 */
export async function reconcileMissingBrokerPosition(
  supabase: SupabaseClient,
  brokerCtx: NonNullable<Awaited<ReturnType<typeof resolveBrokerContext>>>,
  paper: PaperPosition
): Promise<void> {
  const fetcher = brokerCtx.adapter.fetchClosedDealForPosition;
  if (!fetcher) return;
  if (!paper.broker_position_id) return;
  const closed = await fetcher.call(
    brokerCtx.adapter,
    brokerCtx.conn,
    paper.broker_position_id
  );
  if (!closed) return;

  // Classify the exit by comparing close price against SL/TP targets.
  // Without this, every broker-side close (incl. SL/TP fills) was tagged
  // "manual", polluting per-exit-reason stats and the drift detector's
  // future per-cohort analysis. Tolerance = 0.1% of close price (catches
  // typical broker fill slippage; rare false-positive when an operator
  // manually closes at almost exactly the SL/TP price).
  const slPrice = paper.stop_loss_price ? Number(paper.stop_loss_price) : null;
  const tpPrice = paper.take_profit_price ? Number(paper.take_profit_price) : null;
  const tolerance = closed.price * 0.001;
  const matchesTarget = (target: number | null): boolean =>
    target != null && target > 0 && Math.abs(target - closed.price) <= tolerance;
  let exitReason: "stop_loss" | "take_profit" | "manual" = "manual";
  if (matchesTarget(slPrice)) exitReason = "stop_loss";
  else if (matchesTarget(tpPrice)) exitReason = "take_profit";

  await supabase
    .from("paper_positions")
    .update({
      status: "closed",
      exit_price: closed.price,
      exit_reason: exitReason,
      realized_pnl: closed.realizedPnl,
      broker_close_price: closed.price,
      broker_unrealized_pnl: 0,
      closed_at: closed.closedAt,
    })
    .eq("id", paper.id)
    .eq("status", "open");
  await logActivity(supabase, paper.user_id, {
    algorithm_id: paper.algorithm_id,
    event_type: "live_order_closed",
    ticker: paper.ticker,
    details: {
      reason: `broker-side close reconciled (manage cron) — classified as ${exitReason}`,
      exit_price: closed.price,
      sl_price: slPrice,
      tp_price: tpPrice,
      realized_pnl: closed.realizedPnl,
      closed_at: closed.closedAt,
      broker_position_id: paper.broker_position_id,
      exit_reason: exitReason,
    },
  });
}
