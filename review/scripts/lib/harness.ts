/**
 * Review replica of the deploy harness's sibling-aware runner
 * (scripts/canonical/e2.22-layer-b-pinned.ts `runSiblingAwareWeighted`),
 * with the pool capital and the gate set as PARAMETERS so the G.8 baseline
 * can be re-run under paper sizing. Imports the repo's own engine — nothing
 * is re-implemented. Read-only against the DB (rules of the active rows).
 */
import { enumerateLayerBVariants } from "../../../src/lib/algo-search/layer-b-enumerate";
import { computeSlDistance } from "../../../src/lib/algorithm/structural-sl";
import {
  runPortfolioBacktest,
  tradesAsSiblingWindows,
  type PortfolioHaltConfig,
  type RiskPoolConfig,
  type RunPortfolioBacktestOptions,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "../../../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../../src/types/algorithm";
import { readOnlySupabase } from "./env";

export interface Member {
  label: string;
  id?: string;
  rules: AlgorithmRules;
}

/** The five live rows (status='active'), labelled by family. */
export const ACTIVE = [
  { id: "1ebdce3d-4ab9-4e30-b5d3-075942b7cf69", label: "ARB rr3_lb3" },
  { id: "824b6e40-042a-49fa-8d80-61e1e92f6d79", label: "Engulfing rr3_lb6" },
  { id: "f4b56c3a-ff61-4233-a6da-224b39e1668a", label: "ARB rr25_lb3" },
  { id: "6cea13b6-86fb-41f6-9f2c-6bef47541a6a", label: "OutsideBar v2 rr3_lb3" },
  { id: "52e911a6-b4ed-4507-b0a3-5414e40ec16c", label: "Engulfing25 rr25_lb4" },
] as const;

/** The harness's SOURCE rows (LayerB/Search rows it reads instead of the deployed rows). */
export const HARNESS_SOURCE = {
  trio: [
    { id: "069813f1-2a80-48e7-a086-5bf22c05e300", label: "ARB rr3_lb3" },
    { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", label: "Engulfing rr3_lb6" },
    { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", label: "ARB rr25_lb3" },
  ],
  deployedOb: { id: "6cea13b6-86fb-41f6-9f2c-6bef47541a6a", label: "OutsideBar v2 rr3_lb3" },
  engulfingSearch: { id: "02c1892f-a765-4ed8-8d5d-86329392d110", label: "Engulfing25 rr25_lb4" },
} as const;

export function withDailyBias(base: AlgorithmRules, direction: "bullish" | "bearish" = "bullish"): AlgorithmRules {
  const hasBias = base.entry_conditions.some((c) => (c as { pattern?: string }).pattern === "daily_bias");
  return {
    ...base,
    entry_conditions: hasBias
      ? base.entry_conditions
      : [...base.entry_conditions, { type: "pattern", pattern: "daily_bias", direction, ma_period: 20, timeframe: "1d" } as EntryCondition],
    entry_logic: "all",
  };
}

async function fetchRules(id: string): Promise<{ rules: AlgorithmRules; name: string }> {
  const sb = readOnlySupabase();
  const { data, error } = await sb.from("algorithms").select("name, rules").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`algo ${id} not found`);
  return { rules: data.rules as unknown as AlgorithmRules, name: data.name };
}

export async function loadDeployedMembers(): Promise<Member[]> {
  const out: Member[] = [];
  for (const a of ACTIVE) {
    const { rules } = await fetchRules(a.id);
    out.push({ label: a.label, id: a.id, rules });
  }
  return out;
}

/** Exactly what MODE=algo-stats assembles (trio LayerB rows + daily_bias, deployed OB row, Engulfing25 rebuilt from the Search row). */
export async function loadHarnessSourceMembers(): Promise<Member[]> {
  const out: Member[] = [];
  for (const t of HARNESS_SOURCE.trio) out.push({ label: t.label, id: t.id, rules: withDailyBias((await fetchRules(t.id)).rules) });
  out.push({ label: HARNESS_SOURCE.deployedOb.label, id: HARNESS_SOURCE.deployedOb.id, rules: (await fetchRules(HARNESS_SOURCE.deployedOb.id)).rules });
  const engBase = withDailyBias((await fetchRules(HARNESS_SOURCE.engulfingSearch.id)).rules);
  const engV = enumerateLayerBVariants({ name: "Search: XAU/USD Engulfing-Long 4h", ticker: "XAU/USD", capital: 10_000, rules: engBase }).find(
    (v) => v.variant_tag === "rr25_lb4_r06_rf0_af0"
  );
  if (!engV) throw new Error("Engulfing25 variant rr25_lb4_r06_rf0_af0 not found");
  out.push({ label: HARNESS_SOURCE.engulfingSearch.label, rules: engV.rules });
  return out;
}

export interface SiblingAwareOptions {
  /** Uniform risk % override (harness: 0.42). null = use each member's own position_sizing. */
  uniformRisk?: number | null;
  spreadGate?: boolean;
  riskPool?: boolean;
  portfolioHalt?: boolean;
  reEntryCooldown?: boolean;
  siblingBlocking?: boolean;
}

export interface SiblingAwareResult {
  union: BacktestTrade[];
  soloTrades: Map<string, BacktestTrade[]>;
  awareTrades: Map<string, BacktestTrade[]>;
  perMember: Array<{ label: string; solo: number; aware: number }>;
}

/** Replica of runSiblingAwareWeighted with capital + gates parameterised. */
export function runSiblingAware(
  members: Member[],
  bars: PriceBar[],
  dailyBars: PriceBar[],
  capital: number,
  o: SiblingAwareOptions = {}
): SiblingAwareResult {
  const opts = { uniformRisk: 0.42, spreadGate: true, riskPool: true, portfolioHalt: true, reEntryCooldown: true, siblingBlocking: true, ...o };
  const priceMap = new Map([["XAU/USD", bars]]);
  const riskOf = (m: Member): number => opts.uniformRisk ?? (m.rules.position_sizing?.value ?? 0.42);
  const atRisk = (m: Member): AlgorithmRules =>
    opts.uniformRisk == null
      ? m.rules
      : { ...m.rules, position_sizing: { ...m.rules.position_sizing, type: "risk_per_trade", value: opts.uniformRisk } };

  const soloTrades = new Map<string, BacktestTrade[]>();
  for (const m of members) {
    const res = runPortfolioBacktest(atRisk(m), priceMap, capital, { dailyBarsOverride: dailyBars });
    soloTrades.set(m.label, res.trades ?? []);
  }
  const spreadGate: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
  const union: BacktestTrade[] = [];
  const awareTrades = new Map<string, BacktestTrade[]>();
  const perMember: SiblingAwareResult["perMember"] = [];
  for (const m of members) {
    let sibWindows: SiblingTradeWindow[] = [];
    const sibDaily: Record<string, number> = {};
    for (const other of members) {
      if (other.label === m.label) continue;
      const ot = soloTrades.get(other.label)!;
      sibWindows = sibWindows.concat(tradesAsSiblingWindows(ot, capital * (riskOf(other) / 100)));
      for (const t of ot) {
        const day = t.exit_date.slice(0, 10);
        sibDaily[day] = (sibDaily[day] ?? 0) + t.pnl;
      }
    }
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: capital };
    const portfolioHalt: PortfolioHaltConfig = { enabled: true, daily_loss_limit_pct: 5, reference_capital: capital, sibling_daily_pnl: sibDaily };
    const runOpts: RunPortfolioBacktestOptions = {
      dailyBarsOverride: dailyBars,
      ...(opts.siblingBlocking ? { siblingBlockingTrades: sibWindows } : {}),
      ...(opts.riskPool ? { riskPoolSiblings: sibWindows, riskPool } : {}),
      ...(opts.portfolioHalt ? { portfolioHalt } : {}),
      ...(opts.reEntryCooldown ? { reEntryCooldown: { enabled: true } } : {}),
      ...(opts.spreadGate ? { spreadGate } : {}),
    };
    const res = runPortfolioBacktest(atRisk(m), priceMap, capital, runOpts);
    const trades = (res.trades ?? []).map((t) => ({ ...t, ticker: t.ticker ?? "XAU/USD", algo: m.label })) as Array<BacktestTrade & { algo: string }>;
    awareTrades.set(m.label, trades);
    union.push(...trades);
    perMember.push({ label: m.label, solo: soloTrades.get(m.label)!.length, aware: trades.length });
  }
  union.sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  return { union, soloTrades, awareTrades, perMember };
}

/** Harness convention: pnl / (equity_at_entry × risk%). */
export function nominalR(t: BacktestTrade, capital: number, riskPct: number): number {
  const riskDollars = ((t.equity_at_entry ?? capital) * riskPct) / 100;
  return riskDollars > 0 ? t.pnl / riskDollars : 0;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Reconstruct the SL/TP the engine used: entry is at the signal bar's close
 *  (bars[i].date === trade.entry_date); SL distance via the engine's own
 *  computeSlDistance at that index; TP = max(rr × SLd, SLd). */
export function reconstructGeometry(
  t: BacktestTrade,
  rules: AlgorithmRules,
  bars: PriceBar[],
  dateIndex: Map<string, number>
): { idx: number; slDistance: number; sl: number; tp: number } | null {
  const idx = dateIndex.get(t.entry_date);
  if (idx === undefined) return null;
  const slDistance = computeSlDistance(rules.stop_loss, t.side, t.entry_price, "XAU/USD", bars, idx);
  if (!(slDistance > 0)) return null;
  const rr = rules.take_profit?.type === "rr_multiple" ? rules.take_profit.value : 3;
  const tpDistance = Math.max(rr * slDistance, slDistance);
  const sl = t.side === "long" ? t.entry_price - slDistance : t.entry_price + slDistance;
  const tp = t.side === "long" ? t.entry_price + tpDistance : t.entry_price - tpDistance;
  return { idx, slDistance, sl, tp };
}

export function dateIndexOf(bars: PriceBar[]): Map<string, number> {
  const m = new Map<string, number>();
  bars.forEach((b, i) => m.set(b.date, i));
  return m;
}
