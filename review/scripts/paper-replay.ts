/**
 * Phase 1.5 + operator additions #2/#3/#4 — replay the paper period through
 * the engine and match it trade by trade against the 14 live paper trades.
 *  - Backtest: deployed rules, sibling-aware, $100K, on canonical H4 pins
 *    merged with the 2026-10-28 OANDA refresh (so the series runs 2015 →
 *    2026-10-28 and all indicator windows are warm).
 *  - Live: paper_positions opened ≥ 2026-07-20 (read-only DB).
 *  - Matching key: algo + signal bar (last completed 4h bar at opened_at).
 *  - Fill provenance: does the live entry/exit equal a bar close (= the
 *    silent Twelve-Data-quota fallback) rather than a quote?
 *  - Blocker table: per ISO week, per algo, which gate stopped signals.
 *  - Hour-filter ratchet + pair auto-pause simulated over the whole union.
 *  - Live price_cache row vs OANDA refresh (same source? any foreign bars?).
 * Reproduce: pnpm dlx tsx review/scripts/paper-replay.ts
 */
import { writeFileSync } from "node:fs";
import { checkAtrLiquidity } from "../../src/lib/algorithm/intraday-atr-gate";
import { isWeakTrendByAdx } from "../../src/lib/market-data/adx-filter";
import { isRangingByAtr } from "../../src/lib/market-data/regime-filter";
import { alignBarIndex } from "../../src/lib/market-data/resample";
import { detectAsianRangeBreak } from "../../src/lib/patterns/asian-range-break";
import { detectDailyBias } from "../../src/lib/patterns/daily-bias";
import { detectEngulfing } from "../../src/lib/patterns/engulfing";
import { detectOutsideBar } from "../../src/lib/patterns/outside-bar";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import { readOnlySupabase } from "./lib/env";
import { ACTIVE, dateIndexOf, loadDeployedMembers, mean, nominalR, reconstructGeometry, runSiblingAware, type Member } from "./lib/harness";
import { CANONICAL_PINS, REVIEW_PINS, loadPinnedFile, mergeBars, sessionDaily } from "./lib/pins";

const RISK = 0.42, CAP = 100_000, H4_MS = 4 * 3600_000;
const CLOCK_START = "2026-07-20T00:00:00.000Z";
type Live = { id: string; algo: string; side: "long" | "short"; entry_price: number; exit_price: number | null; initial_sl: number | null; tp: number | null; qty: number; exit_reason: string | null; pnl: number | null; opened_at: string; closed_at: string | null };

function isoWeek(d: string): string {
  const dt = new Date(d); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day); return dt.toISOString().slice(0, 10);
}
function detector(pattern: string) {
  return (bars: PriceBar[], i: number): boolean => {
    const r = pattern === "engulfing" ? detectEngulfing(bars, i) : pattern === "outside_bar" ? detectOutsideBar(bars, i) : detectAsianRangeBreak(bars, i);
    return r.detected && (r.details as { direction?: string } | undefined)?.direction === "bullish";
  };
}

async function main() {
  const h4 = mergeBars(loadPinnedFile(CANONICAL_PINS.h4).bars, loadPinnedFile(REVIEW_PINS.h4).bars);
  const dStart = mergeBars(loadPinnedFile(CANONICAL_PINS.d).bars, loadPinnedFile(REVIEW_PINS.d).bars);
  const daily = sessionDaily(dStart);
  const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers();
  const labelById = new Map(ACTIVE.map((a) => [a.id, a.label]));
  console.log(`bars: H4 ${h4.length} (${h4[0].date} → ${h4[h4.length - 1].date}), session dailies ${daily.length} (last ${daily[daily.length - 1].date})`);

  // ---- live trades
  const sb = readOnlySupabase();
  const { data: rows, error } = await sb.from("paper_positions").select("id, algorithm_id, side, entry_price, exit_price, initial_stop_loss_price, take_profit_price, quantity, exit_reason, realized_pnl, opened_at, closed_at").gte("opened_at", CLOCK_START).order("opened_at");
  if (error) throw new Error(error.message);
  const live: Live[] = (rows ?? []).map((r) => ({ id: r.id as string, algo: labelById.get(r.algorithm_id as string) ?? "?", side: r.side as "long" | "short", entry_price: Number(r.entry_price), exit_price: r.exit_price == null ? null : Number(r.exit_price), initial_sl: r.initial_stop_loss_price == null ? null : Number(r.initial_stop_loss_price), tp: r.take_profit_price == null ? null : Number(r.take_profit_price), qty: Number(r.quantity), exit_reason: r.exit_reason as string | null, pnl: r.realized_pnl == null ? null : Number(r.realized_pnl), opened_at: r.opened_at as string, closed_at: r.closed_at as string | null }));
  console.log(`live paper trades since ${CLOCK_START}: ${live.length}`);

  // ---- backtest over the full merged series
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const union = run.union as Array<BacktestTrade & { algo: string }>;
  const rulesByLabel = new Map(members.map((m) => [m.label, m.rules]));
  const grossR = (t: BacktestTrade & { algo: string }): number | null => { const g = reconstructGeometry(t, rulesByLabel.get(t.algo)!, h4, idx); return g ? (t.side === "long" ? t.exit_price - t.entry_price : t.entry_price - t.exit_price) / g.slDistance : null; };
  const btWindow = union.filter((t) => t.entry_date >= CLOCK_START);
  const btLock = union.filter((t) => t.entry_date >= "2026-07-10T00:00:00.000Z");
  console.log(`\nbacktest trades (sibling-aware, $100K): since 2026-07-10 n=${btLock.length}; since clock start n=${btWindow.length}`);
  for (const t of btWindow) console.log(`  ${t.entry_date} ${t.algo.padEnd(22)} ${t.exit_reason?.padEnd(16)} entry=${t.entry_price.toFixed(2)} exit=${t.exit_price.toFixed(2)} nominalR=${nominalR(t, CAP, RISK).toFixed(2)} grossR=${grossR(t)?.toFixed(2)}`);

  // ---- match live ↔ backtest by signal bar
  const lastCompletedIdx = (iso: string): number => { const ms = Date.parse(iso); let lo = 0, hi = h4.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (Date.parse(h4[mid].date) + H4_MS <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans; };
  const btByKey = new Map(btWindow.map((t) => [`${t.algo}|${t.entry_date}`, t]));
  const matches: Array<Record<string, unknown>> = [];
  const liveR = (l: Live): number | null => (l.exit_price == null || l.initial_sl == null) ? null : (l.side === "long" ? l.exit_price - l.entry_price : l.entry_price - l.exit_price) / Math.abs(l.entry_price - l.initial_sl);
  let fallbackEntries = 0, fallbackExits = 0;
  console.log("\nlive trade → signal bar → backtest counterpart:");
  for (const l of live) {
    const sig = lastCompletedIdx(l.opened_at);
    const sigBar = h4[sig];
    const delayMin = Math.round((Date.parse(l.opened_at) - (Date.parse(sigBar.date) + H4_MS)) / 60000);
    const key = `${l.algo}|${sigBar.date}`;
    let bt = btByKey.get(key) ?? null;
    let matchKind = bt ? "exact" : "none";
    if (!bt) { // tolerate ±1 bar
      for (const d of [-1, 1]) { const b = h4[sig + d]; const c = b && btByKey.get(`${l.algo}|${b.date}`); if (c) { bt = c; matchKind = `±1 bar (${b.date})`; break; } }
    }
    const entryIsClose = Math.abs(l.entry_price - sigBar.close) < 0.005 || Math.abs(l.entry_price - (h4[sig - 1]?.close ?? NaN)) < 0.005;
    const exitSig = l.closed_at ? lastCompletedIdx(l.closed_at) : -1;
    const exitIsClose = exitSig >= 0 && l.exit_price != null && (Math.abs(l.exit_price - h4[exitSig].close) < 0.005 || Math.abs(l.exit_price - (h4[exitSig - 1]?.close ?? NaN)) < 0.005);
    if (entryIsClose) fallbackEntries++; if (exitIsClose) fallbackExits++;
    const lr = liveR(l);
    const bgr = bt ? grossR(bt) : null;
    matches.push({ live_id: l.id, algo: l.algo, opened_at: l.opened_at, signal_bar: sigBar.date, entry_delay_min: delayMin, live_entry: l.entry_price, bar_close: sigBar.close, entry_equals_a_bar_close: entryIsClose, exit_equals_a_bar_close: exitIsClose, live_exit: l.exit_price, live_exit_reason: l.exit_reason, live_gross_r: lr, bt_match: matchKind, bt_entry: bt?.entry_price ?? null, bt_exit: bt?.exit_price ?? null, bt_exit_reason: bt?.exit_reason ?? null, bt_gross_r: bgr, bt_nominal_r: bt ? nominalR(bt, CAP, RISK) : null });
    console.log(`  ${l.opened_at.slice(5, 16)} ${l.algo.padEnd(22)} sig=${sigBar.date.slice(5, 16)} delay=${String(delayMin).padStart(4)}m entry=${l.entry_price.toFixed(2)} (barClose ${sigBar.close.toFixed(2)}${entryIsClose ? " ⚠=close" : ""}) exit=${l.exit_price?.toFixed(2)}${exitIsClose ? "⚠=close" : ""} ${l.exit_reason} R=${lr?.toFixed(2)} | bt: ${matchKind}${bt ? ` entry=${bt.entry_price.toFixed(2)} exit=${bt.exit_price.toFixed(2)} ${bt.exit_reason} grossR=${bgr?.toFixed(2)}` : ""}`);
  }
  const matchedLive = matches.filter((m) => m.bt_match !== "none");
  const liveOnly = matches.filter((m) => m.bt_match === "none");
  const matchedKeys = new Set(matchedLive.map((m) => `${m.algo}|${m.signal_bar}`));
  const btOnly = btWindow.filter((t) => !matchedKeys.has(`${t.algo}|${t.entry_date}`) && !matchedLive.some((m) => (m.bt_match as string).includes(t.entry_date)));
  const mR = (xs: Array<number | null | undefined>) => mean(xs.filter((x): x is number => typeof x === "number"));
  console.log(`\nMATCH SUMMARY: live=${live.length} matched=${matchedLive.length} live-only=${liveOnly.length}; backtest trades in window=${btWindow.length}, backtest-only=${btOnly.length}`);
  console.log(`  live mean gross R (all ${live.length}): ${mR(matches.map((m) => m.live_gross_r as number)).toFixed(3)} | matched live: ${mR(matchedLive.map((m) => m.live_gross_r as number)).toFixed(3)} vs their backtest gross R: ${mR(matchedLive.map((m) => m.bt_gross_r as number)).toFixed(3)} (nominal ${mR(matchedLive.map((m) => m.bt_nominal_r as number)).toFixed(3)})`);
  console.log(`  live-only trades mean R: ${mR(liveOnly.map((m) => m.live_gross_r as number)).toFixed(3)} (n=${liveOnly.length}); backtest-only trades mean gross R: ${mR(btOnly.map((t) => grossR(t))).toFixed(3)} (n=${btOnly.length})`);
  console.log(`  fill provenance: entries equal to a bar close ${fallbackEntries}/${live.length}; exits equal to a bar close ${fallbackExits}/${live.filter((l) => l.exit_price != null).length}`);
  console.log(`  backtest-only trades:`); for (const t of btOnly) console.log(`    ${t.entry_date} ${t.algo} ${t.exit_reason} grossR=${grossR(t)?.toFixed(2)}`);

  // ---- per-bar blocker table since clock start (live-aligned bias)
  const weeks: Record<string, Record<string, { bars: number; fired: number; bias: number; atr: number; filters: number }>> = {};
  const eligible: Array<{ date: string; algo: string }> = [];
  const startIdx = h4.findIndex((b) => b.date >= CLOCK_START);
  for (let i = startIdx; i < h4.length; i++) {
    const bar = h4[i]; const wk = isoWeek(bar.date); weeks[wk] = weeks[wk] ?? {};
    const barClose = new Date(Date.parse(bar.date) + H4_MS).toISOString();
    const dIdx = alignBarIndex(daily, barClose);
    const biasR = dIdx >= 0 ? detectDailyBias(daily.slice(0, dIdx + 1), 20) : null;
    const bullish = !!(biasR?.detected && (biasR.details as { bias?: string } | undefined)?.bias === "bullish");
    const atrOk = !checkAtrLiquidity(h4, i).skip;
    for (const m of members) {
      const pat = (m.rules.entry_conditions.find((c) => (c as { pattern?: string }).pattern !== "daily_bias") as { pattern?: string }).pattern!;
      const c = (weeks[wk][m.label] = weeks[wk][m.label] ?? { bars: 0, fired: 0, bias: 0, atr: 0, filters: 0 });
      c.bars++;
      if (!detector(pat)(h4, i)) continue; c.fired++;
      if (!bullish) continue; c.bias++;
      if (!atrOk) continue; c.atr++;
      let ok = true;
      if (m.rules.regime_filter?.enabled && dIdx >= 0 && isRangingByAtr(daily, dIdx, m.rules.regime_filter).skip) ok = false;
      if (ok && m.rules.adx_filter?.enabled && dIdx >= 0 && isWeakTrendByAdx(daily, dIdx, m.rules.adx_filter).skip) ok = false;
      if (!ok) continue; c.filters++; eligible.push({ date: bar.date, algo: m.label });
    }
  }
  console.log("\nBLOCKER TABLE (per ISO week, summed over the 5 algos): bars | pattern fired | +bias bullish | +ATR gate pass | +regime/ADX pass (= eligible signal)");
  for (const [wk, per] of Object.entries(weeks).sort()) {
    const s = Object.values(per).reduce((a, c) => ({ bars: a.bars + c.bars, fired: a.fired + c.fired, bias: a.bias + c.bias, atr: a.atr + c.atr, filters: a.filters + c.filters }), { bars: 0, fired: 0, bias: 0, atr: 0, filters: 0 });
    console.log(`  ${wk}  bars=${String(s.bars).padStart(3)} fired=${String(s.fired).padStart(3)} bias=${String(s.bias).padStart(3)} atr=${String(s.atr).padStart(3)} eligible=${String(s.filters).padStart(3)}`);
  }
  // bias state per week (share of bars bullish) and ATR gate pass share
  const biasShare: Record<string, string> = {};
  for (const [wk, per] of Object.entries(weeks).sort()) { const any = Object.values(per)[0]; biasShare[wk] = `${any.bars} bars`; }

  // ---- hour-filter ratchet + pair auto-pause over the full union (chronological by entry)
  const sorted = [...union].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  const st: Record<string, { taken: Array<BacktestTrade & { algo: string }>; blocked: number; pausedAt: string | null; hourBlockedFirst: string | null }> = {};
  for (const m of members) st[m.label] = { taken: [], blocked: 0, pausedAt: null, hourBlockedFirst: null };
  for (const t of sorted) {
    const s = st[t.algo]; if (s.pausedAt) { s.blocked++; continue; }
    const hour = new Date(Date.parse(t.entry_date) + H4_MS).getUTCHours();
    const prior = s.taken.filter((x) => new Date(Date.parse(x.entry_date) + H4_MS).getUTCHours() === hour && x.exit_date <= t.entry_date.slice(0, 10));
    if (prior.length >= 5 && (100 * prior.filter((x) => x.pnl > 0).length) / prior.length < 45) { s.blocked++; s.hourBlockedFirst = s.hourBlockedFirst ?? t.entry_date; continue; }
    s.taken.push(t);
    const closed = s.taken.filter((x) => x.exit_date <= t.exit_date);
    if (closed.length >= 8 && (100 * closed.filter((x) => x.pnl > 0).length) / closed.length <= 30) s.pausedAt = t.exit_date;
  }
  console.log("\nHOUR-FILTER RATCHET + AUTO-PAUSE simulated over the full union:");
  let takenAll: Array<BacktestTrade & { algo: string }> = [];
  for (const m of members) { const s = st[m.label]; takenAll = takenAll.concat(s.taken); console.log(`  ${m.label.padEnd(22)} union n=${union.filter((t) => t.algo === m.label).length} taken=${s.taken.length} blocked=${s.blocked} first hour-block=${s.hourBlockedFirst ?? "-"} auto-paused=${s.pausedAt ?? "never"}`); }
  console.log(`  PORTFOLIO: union n=${union.length} meanR=${mean(union.map((t) => nominalR(t, CAP, RISK))).toFixed(4)} → with live-only filters n=${takenAll.length} meanR=${mean(takenAll.map((t) => nominalR(t, CAP, RISK))).toFixed(4)}`);

  // ---- live price_cache row vs OANDA refresh
  const { data: pc } = await sb.from("price_cache").select("bars, fetched_at, bar_count").eq("ticker", "XAU/USD").eq("interval", "4h").eq("output_size", "full").maybeSingle();
  let cacheCheck: Record<string, unknown> = { available: false };
  if (pc) {
    const cb = pc.bars as PriceBar[]; const byDate = new Map(h4.map((b) => [b.date, b]));
    let common = 0, mism = 0, foreign = 0, maxDiff = 0;
    for (const b of cb) { const o = byDate.get(b.date); if (!o) { foreign++; continue; } common++; const d = Math.max(Math.abs(o.open - b.open), Math.abs(o.high - b.high), Math.abs(o.low - b.low), Math.abs(o.close - b.close)); if (d > 1e-6) mism++; maxDiff = Math.max(maxDiff, d); }
    cacheCheck = { available: true, cache_bars: cb.length, cache_first: cb[0]?.date, cache_last: cb[cb.length - 1]?.date, fetched_at: pc.fetched_at, common, ohlc_mismatches: mism, max_abs_diff: maxDiff, bars_not_in_oanda: foreign };
    console.log(`\nLIVE price_cache XAU/USD 4h row: ${cb.length} bars ${cb[0]?.date} → ${cb[cb.length - 1]?.date}; vs OANDA: common=${common} mismatches=${mism} max|Δ|=${maxDiff.toFixed(5)} bars-not-in-OANDA=${foreign}`);
  }

  writeFileSync("review/results/paper-replay.json", JSON.stringify({ clock_start: CLOCK_START, live: matches, live_only: liveOnly.length, matched: matchedLive.length, backtest_window: btWindow.map((t) => ({ ...t, gross_r: grossR(t), nominal_r: nominalR(t, CAP, RISK) })), backtest_only: btOnly.map((t) => ({ ...t, gross_r: grossR(t) })), backtest_since_lock: btLock.length, fill_provenance: { entries_equal_bar_close: fallbackEntries, exits_equal_bar_close: fallbackExits }, blocker_weeks: weeks, eligible_signals: eligible, live_filters_sim: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { taken: v.taken.length, blocked: v.blocked, pausedAt: v.pausedAt, hourBlockedFirst: v.hourBlockedFirst }])), live_filters_portfolio: { union_n: union.length, union_mean_r: mean(union.map((t) => nominalR(t, CAP, RISK))), filtered_n: takenAll.length, filtered_mean_r: mean(takenAll.map((t) => nominalR(t, CAP, RISK))) }, cache_check: cacheCheck, generated_at: new Date().toISOString() }, null, 1));
  console.log("\n→ review/results/paper-replay.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
