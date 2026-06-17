/**
 * Live-mirror eligibility — checks each PAPER algo against the
 * operator-stated promotion milestone (`feedback_live_mirror_milestone`):
 *
 *   Paper→live promotion requires 15 days + ≥5 closed paper trades
 *   within ±50% of backtest expected R per trade.
 *
 * Catches live-execution drift vs backtest BEFORE risking real money.
 * Powers the /reports Promotion Eligibility tab.
 *
 * Computes per paper algo (status='active' AND live_trading_enabled=false):
 *   - days_since_deploy: now - algorithms.created_at
 *   - closed_trade_count: count(paper_positions where status=closed)
 *   - realized_mean_r: mean of computeRMultiple(side, entry, initial_SL, exit)
 *   - backtest_expected_r: total_return / total_trades / 1R$
 *     (where 1R$ = capital × risk_per_trade / 100)
 *   - variance_ratio: realized_mean_r / backtest_expected_r
 *   - status: pending | eligible | drift | no_backtest
 *
 * Status logic:
 *   - 'pending' — days < 15 OR trades < 5
 *   - 'drift' — enough data but |variance_ratio - 1| > 0.5
 *   - 'eligible' — enough data AND variance within ±50%
 *   - 'no_backtest' — algorithm has no backtest_results to compare against
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const MIN_DAYS = 15;
const MIN_TRADES = 5;
const MAX_VARIANCE = 0.5; // ±50%

/** Status meanings:
 *   - pending: time/trade gate not yet met
 *   - eligible: gate met AND realized R within ±50% of backtest expected
 *   - ready_unverified: gate met but backtest_results is missing on the
 *     algo row (current deploy scripts don't persist it — operator should
 *     manually compare against scripts/REVALIDATION_REPORT_<date>.md
 *     before promoting). Treat as "look at this, then decide."
 *   - drift: gate met AND realized R diverges from backtest by >50% */
export type EligibilityStatus = "pending" | "eligible" | "ready_unverified" | "drift";

export interface AlgoEligibility {
  algorithm_id: string;
  name: string;
  strategy_id: string | null;
  strategy_name: string | null;
  created_at: string;
  days_since_deploy: number;
  closed_trade_count: number;
  realized_mean_r: number | null;
  backtest_expected_r: number | null;
  /** realized_mean_r / backtest_expected_r — 1.0 = matches backtest;
   *  >1.5 or <0.5 fails the ±50% milestone. Null when either input
   *  is missing. */
  variance_ratio: number | null;
  status: EligibilityStatus;
  /** Human-readable reasons feeding the status, surfaced in the UI
   *  so the operator sees WHY an algo isn't eligible yet. */
  reasons: string[];
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: Record<string, unknown> | null;
  backtest_results: Record<string, unknown> | null;
  strategy_id: string | null;
  created_at: string;
}

interface PositionRow {
  algorithm_id: string;
  side: string;
  entry_price: number;
  exit_price: number | null;
  initial_stop_loss_price: number | null;
  stop_loss_price: number | null;
}

interface StrategyRow {
  id: string;
  name: string;
}

/** R-multiple — duplicates the function from `src/lib/scan/llm-trader-audit.ts`
 *  intentionally so this module has no cross-import surface. Both
 *  versions must stay numerically identical. */
function computeRMultiple(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  exitPrice: number
): number {
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (risk <= 0) return 0;
  const move = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / risk;
}

/** Derive risk-per-trade % from the algorithm's position_sizing rule.
 *  Returns null when the sizing type doesn't map to a clear per-trade
 *  risk %. Used to compute 1R$ for the backtest expected-R derivation. */
function riskPercentFromRules(rules: Record<string, unknown> | null): number | null {
  if (!rules) return null;
  const sizing = rules.position_sizing as Record<string, unknown> | undefined;
  if (!sizing) return null;
  const type = sizing.type as string;
  const value = typeof sizing.value === "number" ? sizing.value : null;
  if (value == null) return null;
  if (type === "risk_per_trade" || type === "conviction_scaled") return value;
  // Other sizing types (lots, fixed_amount, etc) don't expose a per-trade
  // risk percentage cleanly; caller falls back to no_backtest status.
  return null;
}

function backtestExpectedR(algo: AlgoRow): number | null {
  const br = algo.backtest_results;
  if (!br) return null;
  const totalReturn = typeof br.total_return === "number" ? br.total_return : null;
  const totalTrades = typeof br.total_trades === "number" ? br.total_trades : null;
  if (totalReturn == null || totalTrades == null || totalTrades === 0) return null;
  const riskPct = riskPercentFromRules(algo.rules);
  if (riskPct == null || riskPct <= 0) return null;
  const oneRDollars = algo.capital * (riskPct / 100);
  if (oneRDollars <= 0) return null;
  return totalReturn / totalTrades / oneRDollars;
}

function computeStatus(
  days: number,
  trades: number,
  variance: number | null,
  expected: number | null
): { status: EligibilityStatus; reasons: string[] } {
  // Time + trade gate is the operator-stated baseline; it gates everything.
  const reasons: string[] = [];
  if (days < MIN_DAYS) reasons.push(`${MIN_DAYS - days}d more to milestone`);
  if (trades < MIN_TRADES) reasons.push(`${MIN_TRADES - trades} more closed trades needed`);
  if (reasons.length > 0) return { status: "pending", reasons };

  // Gate met — now classify by variance availability.
  if (expected == null) {
    return {
      status: "ready_unverified",
      reasons: [
        "Milestone met. backtest_results not on the algo row — verify variance manually against scripts/REVALIDATION_REPORT_<date>.md",
      ],
    };
  }
  if (variance == null) {
    // Edge case: have expected but no realized — shouldn't happen once trades > 0.
    return { status: "pending", reasons: ["Realized R not yet computable"] };
  }
  if (Math.abs(variance - 1) > MAX_VARIANCE) {
    reasons.push(`variance ${(variance * 100).toFixed(0)}% of backtest (outside ±50%)`);
    return { status: "drift", reasons };
  }
  reasons.push("All criteria met");
  return { status: "eligible", reasons };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

async function fetchPaperAlgos(supabase: Supa): Promise<AlgoRow[]> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules, backtest_results, strategy_id, created_at")
    .eq("status", "active")
    .eq("live_trading_enabled", false);
  if (error) throw new Error(`eligibility algos query failed: ${error.message}`);
  return (data ?? []) as AlgoRow[];
}

async function fetchStrategyNames(supabase: Supa, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase.from("strategies").select("id, name").in("id", ids);
  if (error) throw new Error(`eligibility strategies query failed: ${error.message}`);
  for (const s of (data ?? []) as StrategyRow[]) map.set(s.id, s.name);
  return map;
}

async function fetchClosedPositions(
  supabase: Supa,
  algoIds: string[]
): Promise<Map<string, PositionRow[]>> {
  const map = new Map<string, PositionRow[]>();
  if (algoIds.length === 0) return map;
  const { data, error } = await supabase
    .from("paper_positions")
    .select("algorithm_id, side, entry_price, exit_price, initial_stop_loss_price, stop_loss_price")
    .in("algorithm_id", algoIds)
    .eq("status", "closed");
  if (error) throw new Error(`eligibility positions query failed: ${error.message}`);
  for (const p of (data ?? []) as PositionRow[]) {
    const arr = map.get(p.algorithm_id) ?? [];
    arr.push(p);
    map.set(p.algorithm_id, arr);
  }
  return map;
}

function meanRealizedR(positions: PositionRow[]): number | null {
  const rValues: number[] = [];
  for (const p of positions) {
    const side = p.side === "long" || p.side === "short" ? p.side : null;
    const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
    if (!side || stop == null || p.exit_price == null) continue;
    rValues.push(computeRMultiple(side, p.entry_price, stop, p.exit_price));
  }
  if (rValues.length === 0) return null;
  return rValues.reduce((s, r) => s + r, 0) / rValues.length;
}

function sortByActionability(results: AlgoEligibility[]): AlgoEligibility[] {
  const order: Record<EligibilityStatus, number> = {
    eligible: 0,
    ready_unverified: 1,
    drift: 2,
    pending: 3,
  };
  return results.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    const aGap = Math.max(MIN_DAYS - a.days_since_deploy, MIN_TRADES - a.closed_trade_count, 0);
    const bGap = Math.max(MIN_DAYS - b.days_since_deploy, MIN_TRADES - b.closed_trade_count, 0);
    if (aGap !== bGap) return aGap - bGap;
    return a.name.localeCompare(b.name);
  });
}

export async function buildLiveMirrorEligibility(supabase: Supa): Promise<AlgoEligibility[]> {
  const algos = await fetchPaperAlgos(supabase);
  if (algos.length === 0) return [];

  const strategyIds = [...new Set(algos.map((a) => a.strategy_id).filter(Boolean) as string[])];
  const [strategyById, positionsByAlgo] = await Promise.all([
    fetchStrategyNames(supabase, strategyIds),
    fetchClosedPositions(supabase, algos.map((a) => a.id)),
  ]);

  const now = Date.now();
  const results: AlgoEligibility[] = algos.map((algo) => {
    const daysSince = Math.floor((now - new Date(algo.created_at).getTime()) / 86400_000);
    const positions = positionsByAlgo.get(algo.id) ?? [];
    const meanR = meanRealizedR(positions);
    const expected = backtestExpectedR(algo);
    const variance =
      meanR != null && expected != null && expected !== 0 ? meanR / expected : null;
    const { status, reasons } = computeStatus(daysSince, positions.length, variance, expected);
    return {
      algorithm_id: algo.id,
      name: algo.name,
      strategy_id: algo.strategy_id,
      strategy_name: algo.strategy_id ? (strategyById.get(algo.strategy_id) ?? null) : null,
      created_at: algo.created_at,
      days_since_deploy: daysSince,
      closed_trade_count: positions.length,
      realized_mean_r: meanR,
      backtest_expected_r: expected,
      variance_ratio: variance,
      status,
      reasons,
    };
  });

  return sortByActionability(results);
}
