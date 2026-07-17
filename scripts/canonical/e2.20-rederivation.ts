/**
 * E2.20 — Re-derivation on PINNED data (2026-07-10).
 *
 * Re-derives every NIGHT+4 verdict + re-confirms the 3 deployed longs on the
 * pinned single-provider dataset (scripts/canonical/data/xau-usd-h4-pinned.json,
 * sha256-verified at load). All prior numbers ran on merge-built price_cache
 * rows now known unsound (E2.19 / forensics-2026-07-09.md).
 *
 * PRE-REGISTERED DECISION RULES (locked before first run; echoed at runtime):
 *   R1 3-long re-confirmation PASSES iff at 0.80% risk each: 0 Max-Loss
 *      breaches AND 0 daily breaches across all 60d challenge windows AND
 *      worst ML ≤ 9.5% AND worst DL ≤ 5%.
 *   R2 CHOCH-Short kept iff (a) solo passes operator bar (n≥30, WR≥37,
 *      staticDD≤10, dailyDD≤5, pnl>0); AND (b) 4-algo SIBLING-AWARE stress
 *      non-inferior to 3-algo sibling-aware (0 breaches; worstML ≤ 3algo
 *      worstML + 0.5pp; avgReturn ≥ 3algo avgReturn); AND (c) max |ρ| < 0.40
 *      vs each deployed long. Else ARCHIVE (closes E2.18).
 *   R3 Any other solo passer is a 4th/5th-algo candidate: evaluated by the
 *      same non-inferiority on independent-union stress; the top Δreturn
 *      candidate gets a sibling-aware confirmation. Added only if all gates
 *      green AND Δreturn > 0.
 *   R4 Recommended uniform risk = 0.80% linearly rescaled so the recommended
 *      set's worst-window ML ≈ 8% (2pp FTMO buffer), capped at 1.25%.
 *
 * Stage A — solo runs (fidelity gates OFF, NIGHT+4-comparable) for all 4h
 *   Search:* patterns + the 3 deployed LayerB variants, each + daily_bias,
 *   0.80% risk → operator-bar table (supersedes the NIGHT+4 sweep table).
 * Stage B — 60d/7d-step FTMO challenge stress (Max Loss = FIXED floor) for:
 *   single / 3-algo / 4-algo(+CHOCH) / 3-algo+each passer.
 * Stage C — SIBLING-AWARE pass for 3-algo + finalists (direction-conflict +
 *   risk-pool 4% + portfolio-DLL 5% + re-entry cooldown + spread proxy) —
 *   the live gates the NIGHT+4 stress ignored (3 longs + 1 short on ONE
 *   instrument interact via direction conflict).
 * Stage D — missed-entry audit 2026-06-29T18:00Z → now (entries clean-data
 *   backtest takes that live, on corrupted bars / zombie config, did not).
 * Stage E — verdict JSON → e2-results/e2.20-rederivation-2026-07-10.json.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  runPortfolioBacktest,
  tradesAsSiblingWindows,
  type PortfolioHaltConfig,
  type RiskPoolConfig,
  type RunPortfolioBacktestOptions,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvLocal();

const POOL_CAPITAL = 10_000;
/** Default 0.8 (NIGHT+4/deploy continuity). Override via RISK_PCT env for
 *  exact runs at a proposed uniform risk (R4 sizing verification). */
const RISK_PCT = Number(process.env.RISK_PCT ?? "0.8");
const RISK_DOLLARS = POOL_CAPITAL * (RISK_PCT / 100);
const CHALLENGE_DAYS = 60;
const STEP_DAYS = 7;
const MISSED_WINDOW_START = "2026-06-29T18:00:00Z";

const TRIO = [
  { id: "069813f1-2a80-48e7-a086-5bf22c05e300", label: "ARB rr3_lb3 (deployed)" },
  { id: "daff0052-824a-4cd4-a43c-7fd177fe8513", label: "Engulfing rr3_lb6 (deployed)" },
  { id: "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", label: "ARB rr25_lb3 (deployed)" },
];
const CHOCH_ID = "9d5bbb17-24a7-42bb-9393-ebfa06e2b6f1";

interface SoloStats {
  key: string;
  label: string;
  direction: "Long" | "Short";
  trades: number;
  wr: number;
  static_dd_pct: number;
  daily_dd_pct: number;
  total_pnl: number;
  monthly_pct: number;
  passes_operator_bar: boolean;
  excluded_by_spec: boolean;
}

interface StressResult {
  windows: number;
  pass: number;
  fail_ml: number;
  fail_dl: number;
  worst_ml: number;
  worst_dl: number;
  avg_return_pct: number;
}

function buildRules(base: AlgorithmRules, biasDir: "bullish" | "bearish"): AlgorithmRules {
  const hasBias = base.entry_conditions.some(
    (c) => (c as { pattern?: string }).pattern === "daily_bias"
  );
  const entry_conditions: EntryCondition[] = hasBias
    ? base.entry_conditions
    : [
        ...base.entry_conditions,
        { type: "pattern", pattern: "daily_bias", direction: biasDir, ma_period: 20, timeframe: "1d" } as EntryCondition,
      ];
  return {
    ...base,
    entry_conditions,
    entry_logic: "all",
    position_sizing: { ...base.position_sizing, type: "risk_per_trade", value: RISK_PCT },
  };
}

function soloStats(key: string, label: string, direction: "Long" | "Short", trades: BacktestTrade[], excluded: boolean): SoloStats {
  const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  let equity = POOL_CAPITAL, peak = POOL_CAPITAL, maxDd = 0;
  const daily = new Map<string, number>();
  let wins = 0, total = 0;
  for (const t of sorted) {
    equity += t.pnl;
    total += t.pnl;
    if (t.pnl > 0) wins++;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
    const day = t.exit_date.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + t.pnl);
  }
  let worstDaily = 0;
  for (const p of daily.values()) if (p < 0 && Math.abs(p) > worstDaily) worstDaily = Math.abs(p);
  const dailyDd = (worstDaily / POOL_CAPITAL) * 100;
  const wr = trades.length ? (wins / trades.length) * 100 : 0;
  const spanDays = sorted.length >= 2
    ? (Date.parse(sorted[sorted.length - 1].exit_date) - Date.parse(sorted[0].entry_date)) / 86_400_000
    : 0;
  const monthly = spanDays > 30 ? (total / POOL_CAPITAL / (spanDays / 30.44)) * 100 : 0;
  const passes = !excluded && trades.length >= 30 && wr >= 37 && maxDd <= 10 && dailyDd <= 5 && total > 0;
  return {
    key, label, direction,
    trades: trades.length, wr, static_dd_pct: maxDd, daily_dd_pct: dailyDd,
    total_pnl: total, monthly_pct: monthly, passes_operator_bar: passes, excluded_by_spec: excluded,
  };
}

/** FTMO challenge stress — Max Loss = FIXED floor vs initial (per
 *  feedback_ftmo_max_loss_is_fixed_floor), daily 5%, pass at +10%. */
function stressTest(allTrades: BacktestTrade[]): StressResult {
  const r: StressResult = { windows: 0, pass: 0, fail_ml: 0, fail_dl: 0, worst_ml: 0, worst_dl: 0, avg_return_pct: 0 };
  if (allTrades.length === 0) return r;
  const sorted = [...allTrades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
  const firstMs = Date.parse(sorted[0].exit_date);
  const lastMs = Date.parse(sorted[sorted.length - 1].exit_date);
  const dayMs = 86_400_000;
  let sumReturn = 0;
  for (let startMs = firstMs; startMs + CHALLENGE_DAYS * dayMs <= lastMs; startMs += STEP_DAYS * dayMs) {
    const endMs = startMs + CHALLENGE_DAYS * dayMs;
    let equity = POOL_CAPITAL, minEq = POOL_CAPITAL, profitHit = false, mlBreach = false;
    const daily = new Map<string, number>();
    for (const t of sorted) {
      const e = Date.parse(t.exit_date);
      if (e < startMs || e > endMs) continue;
      daily.set(t.exit_date.slice(0, 10), (daily.get(t.exit_date.slice(0, 10)) ?? 0) + t.pnl);
      equity += t.pnl;
      if (equity < minEq) minEq = equity;
      if (equity <= POOL_CAPITAL * 0.9) mlBreach = true;
      if (equity >= POOL_CAPITAL * 1.1) profitHit = true;
    }
    let worstDay = 0;
    for (const p of daily.values()) if (p < 0 && Math.abs(p) > worstDay) worstDay = Math.abs(p);
    const mlPct = Math.max(0, ((POOL_CAPITAL - minEq) / POOL_CAPITAL) * 100);
    const dlPct = (worstDay / POOL_CAPITAL) * 100;
    if (mlPct > r.worst_ml) r.worst_ml = mlPct;
    if (dlPct > r.worst_dl) r.worst_dl = dlPct;
    r.windows++;
    if (mlBreach) r.fail_ml++;
    else if (worstDay > POOL_CAPITAL * 0.05) r.fail_dl++;
    else if (profitHit) r.pass++;
    sumReturn += ((equity - POOL_CAPITAL) / POOL_CAPITAL) * 100;
  }
  r.avg_return_pct = r.windows ? sumReturn / r.windows : 0;
  return r;
}

function dailySeries(trades: BacktestTrade[], firstMs: number, lastMs: number): number[] {
  const m = new Map<string, number>();
  for (const t of trades) m.set(t.exit_date.slice(0, 10), (m.get(t.exit_date.slice(0, 10)) ?? 0) + t.pnl);
  const out: number[] = [];
  for (let d = firstMs; d <= lastMs; d += 86_400_000) out.push(m.get(new Date(d).toISOString().slice(0, 10)) ?? 0);
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db; da2 += da * da; db2 += db * db;
  }
  const den = Math.sqrt(da2 * db2);
  return den === 0 ? 0 : num / den;
}

function fmtStress(name: string, s: StressResult): string {
  return `  ${name.padEnd(42)} windows=${s.windows} pass=${((s.pass / Math.max(1, s.windows)) * 100).toFixed(1).padStart(5)}% breach=${s.fail_ml + s.fail_dl} worstML=${s.worst_ml.toFixed(2).padStart(5)}% worstDL=${s.worst_dl.toFixed(2).padStart(4)}% avgRet=${s.avg_return_pct.toFixed(2).padStart(5)}%`;
}

async function fetchRules(sb: SupabaseClient<Database>, id: string): Promise<AlgorithmRules> {
  const { data } = await sb.from("algorithms").select("rules").eq("id", id).maybeSingle();
  if (!data) throw new Error(`algo ${id} not found`);
  return data.rules as unknown as AlgorithmRules;
}

async function main(): Promise<void> {
  console.log("E2.20 — re-derivation on PINNED data. Pre-registered rules R1–R4 (see header) LOCKED.\n");

  // Pinned dataset load + integrity check.
  const pinnedPath = resolve(process.cwd(), "scripts/canonical/data/xau-usd-h4-pinned.json");
  const pinned = JSON.parse(readFileSync(pinnedPath, "utf-8")) as {
    manifest: { sha256: string; bar_count: number; last_bar: string };
    bars: PriceBar[];
  };
  const sha = createHash("sha256").update(JSON.stringify(pinned.bars)).digest("hex");
  if (sha !== pinned.manifest.sha256) throw new Error("pinned dataset sha256 mismatch — refusing to run");
  const bars = pinned.bars;
  const priceMap = new Map([["XAU/USD", bars]]);
  console.log(`Pinned H4: ${bars.length} bars → ${pinned.manifest.last_bar} (sha256 ${sha.slice(0, 16)}… VERIFIED)\n`);

  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // ---------------- Stage A: solo table ----------------
  console.log("=== STAGE A — solo runs on pinned data (gates OFF, +daily_bias, 0.80%) ===");
  const { data: searchRows } = await sb
    .from("algorithms")
    .select("id, name, rules")
    .like("name", "Search: XAU/USD %4h");
  if (!searchRows) throw new Error("no Search rows");

  const solos = new Map<string, { stats: SoloStats; trades: BacktestTrade[] }>();
  const runSolo = (key: string, label: string, dir: "Long" | "Short", base: AlgorithmRules, excluded = false): void => {
    const rules = buildRules(base, dir === "Long" ? "bullish" : "bearish");
    const res = runPortfolioBacktest(rules, priceMap, POOL_CAPITAL);
    const trades = res.trades ?? [];
    solos.set(key, { stats: soloStats(key, label, dir, trades, excluded), trades });
  };

  for (const row of searchRows.sort((a, b) => a.name.localeCompare(b.name))) {
    const m = row.name.match(/^Search: XAU\/USD (.+?)-(Long|Short) 4h$/);
    if (!m) continue;
    const [, pattern, dir] = m;
    runSolo(row.id, `${pattern}-${dir}`, dir as "Long" | "Short", row.rules as unknown as AlgorithmRules, pattern === "Doji");
  }
  for (const t of TRIO) runSolo(t.id, t.label, "Long", await fetchRules(sb, t.id));

  const table = [...solos.values()].map((s) => s.stats).sort((a, b) => b.monthly_pct - a.monthly_pct);
  for (const s of table) {
    const flag = s.excluded_by_spec ? "excl" : s.passes_operator_bar ? "✓ PASS" : "✗";
    console.log(
      `  ${s.label.padEnd(32)} n=${String(s.trades).padStart(3)} WR=${s.wr.toFixed(1).padStart(5)}% ` +
      `DD=${s.static_dd_pct.toFixed(2).padStart(5)}% dDD=${s.daily_dd_pct.toFixed(2).padStart(4)}% ` +
      `pnl=$${s.total_pnl.toFixed(0).padStart(6)} mo=${s.monthly_pct.toFixed(2).padStart(5)}% ${flag}`
    );
  }
  const passers = table.filter((s) => s.passes_operator_bar);
  console.log(`\n  Operator-bar passers: ${passers.length} → ${passers.map((p) => p.label).join(" | ") || "(none)"}\n`);

  // ---------------- Stage B: independent-union stress ----------------
  console.log("=== STAGE B — FTMO challenge stress (independent union, NIGHT+4-comparable) ===");
  const trioTrades = TRIO.flatMap((t) => solos.get(t.id)!.trades);
  const chochTrades = solos.get(CHOCH_ID)?.trades ?? [];
  const stress3 = stressTest(trioTrades);
  const stress4 = stressTest([...trioTrades, ...chochTrades]);
  console.log(fmtStress("3-algo (deployed trio)", stress3));
  console.log(fmtStress("4-algo (trio + CHOCH-Short)", stress4));
  const additions: Array<{ key: string; label: string; stress: StressResult; delta: number; maxCorr: number }> = [];
  let firstMs = Infinity, lastMs = -Infinity;
  for (const t of trioTrades) {
    const ms = Date.parse(t.exit_date);
    if (ms < firstMs) firstMs = ms;
    if (ms > lastMs) lastMs = ms;
  }
  const trioSeries = TRIO.map((t) => dailySeries(solos.get(t.id)!.trades, firstMs, lastMs));
  for (const p of passers) {
    if (TRIO.some((t) => t.id === p.key)) continue;
    const candTrades = solos.get(p.key)!.trades;
    const st = stressTest([...trioTrades, ...candTrades]);
    const candSeries = dailySeries(candTrades, firstMs, lastMs);
    const maxCorr = Math.max(...trioSeries.map((s) => Math.abs(pearson(candSeries, s))));
    additions.push({ key: p.key, label: p.label, stress: st, delta: st.avg_return_pct - stress3.avg_return_pct, maxCorr });
    console.log(fmtStress(`3-algo + ${p.label}`, st) + ` |maxρ|=${maxCorr.toFixed(3)} Δret=${st.avg_return_pct - stress3.avg_return_pct >= 0 ? "+" : ""}${(st.avg_return_pct - stress3.avg_return_pct).toFixed(2)}`);
  }
  console.log("");

  // ---------------- Stage C: sibling-aware finals ----------------
  console.log("=== STAGE C — SIBLING-AWARE stress (direction-conflict + risk-pool 4% + portfolio-DLL 5% + cooldown + spread proxy) ===");
  const spreadGate: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
  const runSiblingAware = async (memberIds: string[]): Promise<{ union: BacktestTrade[]; blocked: Array<{ label: string; solo: number; aware: number }> }> => {
    const union: BacktestTrade[] = [];
    const blocked: Array<{ label: string; solo: number; aware: number }> = [];
    for (const id of memberIds) {
      const self = solos.get(id)!;
      let sibWindows: SiblingTradeWindow[] = [];
      const sibDaily: Record<string, number> = {};
      for (const other of memberIds) {
        if (other === id) continue;
        const ot = solos.get(other)!.trades;
        sibWindows = sibWindows.concat(tradesAsSiblingWindows(ot, RISK_DOLLARS));
        for (const t of ot) {
          const day = t.exit_date.slice(0, 10);
          sibDaily[day] = (sibDaily[day] ?? 0) + t.pnl;
        }
      }
      const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: POOL_CAPITAL };
      const portfolioHalt: PortfolioHaltConfig = { enabled: true, daily_loss_limit_pct: 5, reference_capital: POOL_CAPITAL, sibling_daily_pnl: sibDaily };
      const opts: RunPortfolioBacktestOptions = {
        siblingBlockingTrades: sibWindows,
        riskPoolSiblings: sibWindows,
        riskPool,
        portfolioHalt,
        reEntryCooldown: { enabled: true },
        spreadGate,
      };
      const base = await fetchRules(sb, id);
      const dir = id === CHOCH_ID ? "bearish" : "bullish";
      const rules = buildRules(base, dir);
      const res = runPortfolioBacktest(rules, priceMap, POOL_CAPITAL, opts);
      const trades = res.trades ?? [];
      union.push(...trades);
      blocked.push({ label: self.stats.label, solo: self.trades.length, aware: trades.length });
    }
    return { union, blocked };
  };

  const aware3 = await runSiblingAware(TRIO.map((t) => t.id));
  const aware3Stress = stressTest(aware3.union);
  console.log(fmtStress("3-algo SIBLING-AWARE", aware3Stress));
  for (const b of aware3.blocked) console.log(`      ${b.label}: ${b.solo} solo → ${b.aware} aware (${b.solo - b.aware} gated)`);

  const aware4 = await runSiblingAware([...TRIO.map((t) => t.id), CHOCH_ID]);
  const aware4Stress = stressTest(aware4.union);
  console.log(fmtStress("4-algo (+CHOCH) SIBLING-AWARE", aware4Stress));
  for (const b of aware4.blocked) console.log(`      ${b.label}: ${b.solo} solo → ${b.aware} aware (${b.solo - b.aware} gated)`);

  // AWARE_EXTRA: comma-separated algo ids appended to the trio for one
  // explicit sibling-aware run (exact verification of a proposed portfolio
  // at the chosen RISK_PCT — e.g. 4-algo or 5-algo compositions).
  const awareExtra = (process.env.AWARE_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (awareExtra.length > 0) {
    const members = [...TRIO.map((t) => t.id), ...awareExtra];
    const labels = awareExtra.map((id) => solos.get(id)?.stats.label ?? id).join(" + ");
    const awareX = await runSiblingAware(members);
    const sX = stressTest(awareX.union);
    console.log(fmtStress(`EXPLICIT trio + ${labels} SIBLING-AWARE`, sX));
    for (const b of awareX.blocked) console.log(`      ${b.label}: ${b.solo} solo → ${b.aware} aware (${b.solo - b.aware} gated)`);
  }

  let awareBestAdd: { label: string; stress: StressResult } | null = null;
  const bestAdd = additions.filter((a) => a.stress.fail_ml + a.stress.fail_dl === 0 && a.stress.worst_ml <= 10 && a.stress.worst_dl <= 5 && a.maxCorr < 0.4 && a.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  if (bestAdd) {
    const awareBest = await runSiblingAware([...TRIO.map((t) => t.id), bestAdd.key]);
    const s = stressTest(awareBest.union);
    awareBestAdd = { label: bestAdd.label, stress: s };
    console.log(fmtStress(`3-algo + ${bestAdd.label} SIBLING-AWARE`, s));
    for (const b of awareBest.blocked) console.log(`      ${b.label}: ${b.solo} solo → ${b.aware} aware (${b.solo - b.aware} gated)`);
  }
  console.log("");

  // ---------------- Stage D: missed-entry audit ----------------
  console.log(`=== STAGE D — missed-entry audit (${MISSED_WINDOW_START} → now; presumptive: live gates could still veto) ===`);
  const missed: Array<{ label: string; entry: string; side: string; pnl: number }> = [];
  for (const id of [...TRIO.map((t) => t.id), CHOCH_ID]) {
    const s = solos.get(id);
    if (!s) continue;
    for (const t of s.trades) {
      if (t.entry_date >= MISSED_WINDOW_START) {
        missed.push({ label: s.stats.label, entry: t.entry_date, side: t.side, pnl: t.pnl });
        console.log(`  MISSED: ${s.stats.label} ${t.side} entry ${t.entry_date} (pnl if held to backtest exit: $${t.pnl.toFixed(0)})`);
      }
    }
  }
  if (missed.length === 0) console.log("  (none — clean-data backtest also takes no entries in the window)");
  console.log("");

  // ---------------- Stage E: verdicts ----------------
  console.log("=== STAGE E — pre-registered verdicts ===");
  const chochStats = solos.get(CHOCH_ID)?.stats;
  const chochCorr = chochStats ? Math.max(...trioSeries.map((s) => Math.abs(pearson(dailySeries(chochTrades, firstMs, lastMs), s)))) : 1;
  const r1Pass = aware3Stress.fail_ml + aware3Stress.fail_dl === 0 && aware3Stress.worst_ml <= 9.5 && aware3Stress.worst_dl <= 5;
  const r2a = chochStats?.passes_operator_bar ?? false;
  const r2b = aware4Stress.fail_ml + aware4Stress.fail_dl === 0 && aware4Stress.worst_ml <= aware3Stress.worst_ml + 0.5 && aware4Stress.avg_return_pct >= aware3Stress.avg_return_pct;
  const r2c = chochCorr < 0.4;
  const r2Pass = r2a && r2b && r2c;
  const recommendedRisk = Math.min(1.25, aware3Stress.worst_ml > 0 ? (8 / aware3Stress.worst_ml) * RISK_PCT : RISK_PCT);
  console.log(`  R1 (3-long re-confirmation, sibling-aware): ${r1Pass ? "✓ PASS" : "✗ FAIL"} (breach=${aware3Stress.fail_ml + aware3Stress.fail_dl}, worstML=${aware3Stress.worst_ml.toFixed(2)}%, worstDL=${aware3Stress.worst_dl.toFixed(2)}%)`);
  console.log(`  R2 (CHOCH keep): ${r2Pass ? "✓ KEEP" : "✗ ARCHIVE"} — solo-bar=${r2a} non-inferior=${r2b} |ρ|<0.40=${r2c} (|ρ|max=${chochCorr.toFixed(3)})`);
  console.log(`  R3 (additions): ${bestAdd ? `top candidate ${bestAdd.label} (Δret +${bestAdd.delta.toFixed(2)}, |ρ|max ${bestAdd.maxCorr.toFixed(3)})` : "no qualifying candidate"}`);
  console.log(`  R4 (risk sizing on 3-algo aware worstML): recommended uniform risk ≈ ${recommendedRisk.toFixed(2)}% (worstML→~8%)`);

  const out = {
    computed_at: new Date().toISOString(),
    pinned_sha256: sha,
    pinned_bars: bars.length,
    stage_a: table,
    stage_b: { stress3, stress4, additions },
    stage_c: { aware3: aware3Stress, aware3_blocked: aware3.blocked, aware4: aware4Stress, aware4_blocked: aware4.blocked, awareBestAdd },
    stage_d: missed,
    verdicts: { r1Pass, r2: { r2a, r2b, r2c, r2Pass, chochCorr }, bestAdd: bestAdd ?? null, recommendedRisk },
  };
  const riskTag = RISK_PCT === 0.8 ? "" : `-r${String(RISK_PCT).replace(".", "")}`;
  const outPath = resolve(process.cwd(), `scripts/canonical/e2-results/e2.20-rederivation-2026-07-10${riskTag}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nJSON → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
