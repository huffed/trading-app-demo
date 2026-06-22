/**
 * Post-insert broker-mirror + audit + lot derivation for openPosition.
 * Extracted from `entry-open.ts` on 2026-06-22 (CB.H1 pass 12) so the
 * orchestrator stays focused on sizing + cohort + insert; the mirror
 * branch + lot-derivation policy live alongside each other here.
 */
import { getContractSize } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import { logActivity } from "./helpers";
import { executeLiveEntry, type BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Derive lot count for the broker mirror. For "lots" sizing it's the
 *  rule value verbatim. For "risk_per_trade" / "conviction_scaled" we
 *  back-compute from the sized quantity (which calculatePositionSize
 *  already produced via riskToLots). Other sizing types don't map to a
 *  meaningful lot count → undefined. */
export function deriveLotSizingForMirror(
  rules: AlgorithmRules,
  ticker: string,
  sizedQuantity: number
): number | undefined {
  if (rules.position_sizing.type === "lots") {
    return rules.position_sizing.value;
  }
  if (
    rules.position_sizing.type === "risk_per_trade" ||
    rules.position_sizing.type === "conviction_scaled"
  ) {
    const contract = getContractSize(ticker, rules.asset_class);
    return contract > 0 ? sizedQuantity / contract : undefined;
  }
  return undefined;
}

interface LogAndMirrorArgs {
  supabase: SupabaseClient;
  userId: string;
  algoId: string;
  algoCapital: number;
  paperPositionId: string;
  ticker: string;
  side: "long" | "short";
  sizing: { quantity: number; notionalValue: number };
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  brokerCtx: BrokerExecutionContext | null;
  /** When the algo uses lot-based sizing, this is the raw lot count.
   *  Threaded to executeLiveEntry so JPY crosses don't get mis-converted. */
  lots?: number;
  /** Optional cumulative divergence kill switch from algo rules. */
  divergenceRule?: { max_avg_bps: number; window_trades: number };
}

/** Audit `position_opened` + mirror to broker when liveCtx is present.
 *  Best-effort: a broker reject is handled inside executeLiveEntry (it
 *  closes the paper row with `exit_reason='broker_rejected'`). */
export async function logOpenAndMirror(args: LogAndMirrorArgs): Promise<void> {
  await logActivity(args.supabase, args.userId, {
    algorithm_id: args.algoId,
    position_id: args.paperPositionId,
    event_type: "position_opened",
    ticker: args.ticker,
    details: {
      entry_price: args.currentPrice,
      quantity: args.sizing.quantity,
      notional_value: args.sizing.notionalValue,
      stop_loss_price: args.stopLossPrice,
      take_profit_price: args.takeProfitPrice,
    },
  });
  if (args.brokerCtx) {
    await executeLiveEntry({
      supabase: args.supabase,
      userId: args.userId,
      algorithmId: args.algoId,
      paperPositionId: args.paperPositionId,
      ticker: args.ticker,
      side: args.side,
      notionalUsd: args.sizing.notionalValue,
      currentPrice: args.currentPrice,
      stopLossPrice: args.stopLossPrice,
      takeProfitPrice: args.takeProfitPrice,
      ctx: args.brokerCtx,
      capital: args.algoCapital,
      lots: args.lots,
      divergenceRule: args.divergenceRule,
    });
  }
}
