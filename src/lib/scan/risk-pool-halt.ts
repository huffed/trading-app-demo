/**
 * Risk-pooling halt for multi-algo deployments on the same broker.
 *
 * When two or more algos share a broker connection (e.g. v1 4h + Intraday
 * 30m on the same FTMO Demo $100K account, or future multi-instrument
 * deployments), each algo's `max_positions` setting only bounds ITS OWN
 * open exposure. Combined exposure across algos is unmeasured by the
 * per-algo gate.
 *
 * This module computes the combined risk currently committed to open
 * positions on a given broker and refuses a new entry when (combined +
 * proposed) would exceed a hard cap. Default 3% — under FTMO's 5% daily
 * loss limit so that even if every open position simultaneously took a
 * full -1R, the day's loss stays bounded inside the survival rule.
 *
 * Scope:
 *  - Per-broker (multi-broker setups stay independent)
 *  - Live-only (multi-algo backtest harness already simulates portfolio
 *    behaviour at the harness layer; this gate is the production
 *    equivalent)
 *  - Hard refuse (no scaling-down). Operator-tunable cap if more
 *    nuance needed later.
 *
 * Distinct from:
 *  - `daily-halt.ts` (force-close on daily loss limit hit) — survival
 *    after losses have realised
 *  - `consec-loss-halt.ts` (skip after streak of losses) — discipline
 *    rule on closed trades
 *  - `consistency-halt.ts` (FTMO consistency-rule guard) — payout-time
 *    constraint
 *
 * This gate is about CONCURRENT EXPOSURE. Stops the scenario where 4
 * algos all fire on a momentum signal and combined exposure hits 6%
 * → one bad correlated day = challenge-fail.
 */
import { pnlInUsd } from "@/lib/constants/markets";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RiskPoolHaltResult {
  tripped: boolean;
  /** Combined risk pct currently open on the broker (0-100). */
  currentRiskPct: number;
  /** Risk pct of the proposed new entry (0-100). */
  proposedRiskPct: number;
  /** What current + proposed would be (0-100). */
  combinedRiskPct: number;
  /** Cap being measured against (0-100). */
  capPct: number;
}

interface OpenRow {
  ticker: string | null;
  side: "long" | "short" | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
  algorithm_id: string;
}

/** Default combined risk cap as % of capital. Under FTMO's 5% DLL by
 *  enough margin that simultaneous full-stop hits don't breach the
 *  daily survival rule. Tunable via algorithm rules or env if needed. */
const DEFAULT_COMBINED_RISK_CAP_PCT = 3.0;

/** Minimum cap (sanity bound — operator can't accidentally configure 0
 *  which would block all entries). */
const MIN_CAP_PCT = 0.5;
/** Maximum cap (operator can't accidentally let combined exposure
 *  exceed 5% — that's the FTMO DLL line). */
const MAX_CAP_PCT = 5.0;

/** Compute the dollar risk of one open position — the loss it would
 *  realise if it hit its stop loss. Returns 0 when SL fields are
 *  missing (legacy data, manual trades) — conservative; missing SL =
 *  unknown risk = don't pretend it's contributing to the pool. */
function positionRiskUsd(row: OpenRow): number {
  if (
    row.ticker == null ||
    row.side == null ||
    row.entry_price == null ||
    row.stop_loss_price == null ||
    row.quantity == null
  ) {
    return 0;
  }
  // pnlInUsd computes signed P&L; for SL hit on a long, exit < entry → negative.
  // We want absolute risk magnitude.
  const pnlAtSl = pnlInUsd(
    row.ticker,
    row.side,
    row.entry_price,
    row.stop_loss_price,
    row.quantity
  );
  return Math.abs(pnlAtSl);
}

/**
 * Compute combined open-position risk on a broker connection and check
 * whether a proposed new entry would push combined risk past the cap.
 *
 * Caller passes:
 *  - brokerConnectionId: which broker to scope to
 *  - capital: account size (used to convert dollar risk → %)
 *  - proposedRiskUsd: dollar risk of the entry being evaluated
 *  - cap: optional override (default 3% combined cap)
 *
 * Returns `tripped: true` when combined > cap. Caller decides what to
 * do with it (refuse + log, scale down, etc.). */
export async function checkRiskPoolHalt(
  supabase: SupabaseClient,
  brokerConnectionId: string,
  capital: number,
  proposedRiskUsd: number,
  cap: number = DEFAULT_COMBINED_RISK_CAP_PCT
): Promise<RiskPoolHaltResult> {
  // Clamp cap to sane bounds.
  const effectiveCap = Math.min(Math.max(cap, MIN_CAP_PCT), MAX_CAP_PCT);

  // All open paper_positions whose owning algorithm shares this broker
  // connection. The join via algorithm_id → algorithms.broker_connection_id
  // is the source of truth — paper_positions itself doesn't carry the
  // broker connection field.
  const { data: algoRows } = await supabase
    .from("algorithms")
    .select("id")
    .eq("broker_connection_id", brokerConnectionId);

  const algoIds = (algoRows ?? []).map((a: { id: string }) => a.id);
  if (algoIds.length === 0) {
    // No algos on this broker yet — nothing to pool against.
    const proposedRiskPct = capital > 0 ? (proposedRiskUsd / capital) * 100 : 0;
    return {
      tripped: false,
      currentRiskPct: 0,
      proposedRiskPct,
      combinedRiskPct: proposedRiskPct,
      capPct: effectiveCap,
    };
  }

  const { data } = await supabase
    .from("paper_positions")
    .select("ticker, side, entry_price, stop_loss_price, quantity, algorithm_id")
    .in("algorithm_id", algoIds)
    .eq("status", "open");

  const rows = (data ?? []) as OpenRow[];
  const currentRiskUsd = rows.reduce((s, r) => s + positionRiskUsd(r), 0);

  const currentRiskPct = capital > 0 ? (currentRiskUsd / capital) * 100 : 0;
  const proposedRiskPct = capital > 0 ? (proposedRiskUsd / capital) * 100 : 0;
  const combinedRiskPct = currentRiskPct + proposedRiskPct;

  return {
    tripped: combinedRiskPct > effectiveCap,
    currentRiskPct,
    proposedRiskPct,
    combinedRiskPct,
    capPct: effectiveCap,
  };
}
