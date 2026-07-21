/**
 * M1 evidence tracker — the G.8 gate comparator (MILESTONE M1 "First
 * Proven Stream"). Computes live paper-trade per-trade R from
 * `paper_positions` and tracks the cumulative portfolio mean against the
 * fidelity-corrected backtest baseline (±30% band at 30 trades).
 *
 * Why this exists as a live surface rather than a one-shot script at
 * trade 30: divergence caught at trade 5 is a config/pipeline bug we can
 * fix; divergence discovered at trade 30 is five wasted months.
 *
 * R semantics (canonical, matches llm-trader-audit / eligibility /
 * alpha-decay / vol-target):
 *   R = move / risk, price-delta form, side-signed,
 *   risk anchored on `initial_stop_loss_price` (write-once at open;
 *   `stop_loss_price` moves on BE and would destroy the 1R denominator).
 * Fees/slippage are EXCLUDED on both sides of the comparison (the
 * baseline harness R is friction-inclusive in pnl but risk-normalized
 * the same way; residual friction asymmetry is part of what the demo
 * measures). Broken rows (risk ≤ 0 / missing prices) are EXCLUDED from
 * the mean and surfaced via `excluded_rows` — a 0R placeholder would
 * silently drag the gate statistic.
 *
 * Evidence-clock (E2.24.g.v): only positions opened at/after
 * `clock_start` (the 5-algo re-baseline) count. Per-trade risk% at entry
 * is recorded on each row (derived: |entry − initial_SL| × qty /
 * capital) so uniform risk rescales don't reset the counter.
 */
import { M1_BASELINE, type M1AlgoBaseline, type M1Baseline } from "./m1-baseline";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface M1TradeRow {
  position_id: string;
  algorithm_id: string;
  algorithm_name: string;
  ticker: string;
  side: "long" | "short";
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  /** Per-trade R (closed rows only; null for open/broken rows). */
  r_multiple: number | null;
  /** Risk % of capital at entry (evidence-clock bookkeeping). */
  risk_pct_at_entry: number | null;
  exit_reason: string | null;
}

export interface M1AlgoProgress {
  algorithm_id: string;
  algorithm_name: string;
  /** Matched baseline entry (null when the live name isn't in the
   *  baseline — e.g. a future addition before re-baselining). */
  baseline: M1AlgoBaseline | null;
  closed_trades: number;
  open_positions: number;
  mean_r: number | null;
  win_rate_pct: number | null;
}

export type M1Status = "no_trades" | "accruing" | "gate_reached";

export interface M1Evidence {
  generated_at: string;
  clock_start: string;
  gate: { min_trades: number; tolerance_pct: number };
  /** Portfolio baseline mean per-trade R (the gate reference). */
  baseline_mean_r: number;
  baseline_wr_pct: number;
  /** PASS band: baseline × (1 ± tolerance). */
  band: { lower_r: number; upper_r: number };
  /** Closed trades counted toward the 30-trade gate. */
  closed_trades: number;
  open_positions: number;
  /** Broken rows excluded from the mean (risk ≤ 0 / missing prices). */
  excluded_rows: number;
  realized_mean_r: number | null;
  realized_win_rate_pct: number | null;
  /** realized / baseline (1.0 = tracking exactly). */
  tracking_ratio: number | null;
  /** Whether the current cumulative mean sits inside the band (null
   *  until the first closed trade). Informational before min_trades;
   *  the verdict at gate_reached. */
  in_band: boolean | null;
  status: M1Status;
  per_algo: M1AlgoProgress[];
  /** Newest first, capped at 50. */
  trades: M1TradeRow[];
}

/** R-multiple — duplicates `src/lib/scan/llm-trader-audit.ts`
 *  intentionally (no cross-import surface; both must stay numerically
 *  identical). Returns null (not 0) on broken input: an excluded row is
 *  honest, a fake 0R drags the gate mean. */
function computeRMultiple(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  exitPrice: number
): number | null {
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (risk <= 0) return null;
  const move = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / risk;
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
}

interface PositionRow {
  id: string;
  algorithm_id: string;
  ticker: string;
  side: "long" | "short";
  status: "open" | "closed";
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  stop_loss_price: number | null;
  initial_stop_loss_price: number | null;
  opened_at: string;
  closed_at: string | null;
  exit_reason: string | null;
}

const TRADES_DISPLAY_CAP = 50;

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const winRate = (xs: number[]): number | null =>
  xs.length === 0 ? null : (xs.filter((x) => x > 0).length / xs.length) * 100;

async function fetchActiveAlgos(supabase: SupabaseClient): Promise<AlgoRow[]> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, capital")
    .eq("status", "active");
  if (error) throw new Error(`M1 evidence: algorithms query failed: ${error.message}`);
  return (data ?? []) as AlgoRow[];
}

async function fetchClockedPositions(
  supabase: SupabaseClient,
  algoIds: string[],
  clockStart: string
): Promise<PositionRow[]> {
  if (algoIds.length === 0) return [];
  const { data, error } = await supabase
    .from("paper_positions")
    .select(
      "id, algorithm_id, ticker, side, status, quantity, entry_price, exit_price, stop_loss_price, initial_stop_loss_price, opened_at, closed_at, exit_reason"
    )
    .in("algorithm_id", algoIds)
    .gte("opened_at", clockStart)
    .order("opened_at", { ascending: false });
  if (error) throw new Error(`M1 evidence: paper_positions query failed: ${error.message}`);
  return (data ?? []) as PositionRow[];
}

interface ProcessedPositions {
  trades: M1TradeRow[];
  rByAlgo: Map<string, number[]>;
  excludedRows: number;
  openPositions: number;
}

/** Classify each position row: open (no R), closed-valid (R into the gate
 *  statistic), closed-broken (excluded + counted). Also derives the
 *  evidence-clock risk%-at-entry bookkeeping per row. */
function processPositions(
  positions: PositionRow[],
  algoById: Map<string, AlgoRow>
): ProcessedPositions {
  const trades: M1TradeRow[] = [];
  const rByAlgo = new Map<string, number[]>();
  let excludedRows = 0;
  let openPositions = 0;

  for (const p of positions) {
    const algo = algoById.get(p.algorithm_id);
    const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
    let r: number | null = null;
    if (p.status === "open") {
      openPositions++;
    } else if (stop == null || p.exit_price == null) {
      excludedRows++;
    } else {
      r = computeRMultiple(p.side, p.entry_price, stop, p.exit_price);
      if (r === null) excludedRows++;
      else {
        const list = rByAlgo.get(p.algorithm_id) ?? [];
        list.push(r);
        rByAlgo.set(p.algorithm_id, list);
      }
    }

    const riskDollars = stop != null ? Math.abs(p.entry_price - stop) * p.quantity : null;
    const riskPct =
      riskDollars != null && algo != null && algo.capital > 0
        ? (riskDollars / algo.capital) * 100
        : null;

    trades.push({
      position_id: p.id,
      algorithm_id: p.algorithm_id,
      algorithm_name: algo?.name ?? p.algorithm_id,
      ticker: p.ticker,
      side: p.side,
      opened_at: p.opened_at,
      closed_at: p.closed_at,
      status: p.status,
      r_multiple: r,
      risk_pct_at_entry: riskPct,
      exit_reason: p.exit_reason,
    });
  }

  return { trades, rByAlgo, excludedRows, openPositions };
}

function buildPerAlgo(
  algoRows: AlgoRow[],
  positions: PositionRow[],
  rByAlgo: Map<string, number[]>,
  baseline: M1Baseline
): M1AlgoProgress[] {
  const baselineByName = new Map(baseline.per_algo.map((b) => [b.live_name, b]));
  return algoRows
    .map((a) => {
      const rs = rByAlgo.get(a.id) ?? [];
      return {
        algorithm_id: a.id,
        algorithm_name: a.name,
        baseline: baselineByName.get(a.name) ?? null,
        closed_trades: rs.length,
        open_positions: positions.filter((p) => p.algorithm_id === a.id && p.status === "open")
          .length,
        mean_r: mean(rs),
        win_rate_pct: winRate(rs),
      };
    })
    .sort((x, y) => x.algorithm_name.localeCompare(y.algorithm_name));
}

function deriveStatus(closedTrades: number, minTrades: number): M1Status {
  if (closedTrades === 0) return "no_trades";
  if (closedTrades >= minTrades) return "gate_reached";
  return "accruing";
}

export async function buildM1Evidence(
  supabase: SupabaseClient,
  baseline: M1Baseline = M1_BASELINE
): Promise<M1Evidence> {
  const algoRows = await fetchActiveAlgos(supabase);
  const algoById = new Map(algoRows.map((a) => [a.id, a]));
  const positions = await fetchClockedPositions(
    supabase,
    algoRows.map((a) => a.id),
    baseline.clock_start
  );

  const { trades, rByAlgo, excludedRows, openPositions } = processPositions(positions, algoById);

  const allR = [...rByAlgo.values()].flat();
  const closedTrades = allR.length;
  const realizedMeanR = mean(allR);
  const baselineMeanR = baseline.portfolio.mean_r;
  const tol = baseline.gate.tolerance_pct / 100;
  const band = { lower_r: baselineMeanR * (1 - tol), upper_r: baselineMeanR * (1 + tol) };
  const inBand =
    realizedMeanR === null
      ? null
      : realizedMeanR >= band.lower_r && realizedMeanR <= band.upper_r;

  return {
    generated_at: new Date().toISOString(),
    clock_start: baseline.clock_start,
    gate: baseline.gate,
    baseline_mean_r: baselineMeanR,
    baseline_wr_pct: baseline.portfolio.wr_pct,
    band,
    closed_trades: closedTrades,
    open_positions: openPositions,
    excluded_rows: excludedRows,
    realized_mean_r: realizedMeanR,
    realized_win_rate_pct: winRate(allR),
    tracking_ratio: realizedMeanR === null ? null : realizedMeanR / baselineMeanR,
    in_band: inBand,
    status: deriveStatus(closedTrades, baseline.gate.min_trades),
    per_algo: buildPerAlgo(algoRows, positions, rByAlgo, baseline),
    trades: trades.slice(0, TRADES_DISPLAY_CAP),
  };
}
