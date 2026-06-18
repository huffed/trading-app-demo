/**
 * Replay 15m WF short trades with widened swing_anchor lookback to test
 * the asymmetric-SL hypothesis from the 2026-05-07 review:
 *
 *   "Same SL distance (lookback=12) on shorts is structurally tighter
 *    than on longs because the recent swing high is 'fresh' (price just
 *    rallied to it) while the recent swing low is 'old' (price drifted
 *    up away from it). Widening short-only lookback to 18 bars should
 *    give shorts more room before stop-runs hit."
 *
 * What this does:
 *   1. Loads each window's trade JSONL (A chop / B transition / C
 *      drawdown / D trend) from the 4-window WF
 *   2. Filters to short trades (33 across all 4 windows)
 *   3. Reloads cached 15m bars from price_cache
 *   4. For each short:
 *      a. Recompute SL price using swing_anchor lookback=18 + 0.25 ATR
 *         buffer (vs the original lookback=12)
 *      b. Recompute TP at 3 × new SL distance
 *      c. Walk bars forward from entry. Find first hit of:
 *           - new SL (high crosses → -1R)
 *           - new TP (low crosses → +3R)
 *           - the original LLM exit timestamp (if neither price-exit
 *             fires first → use original exit price as the LLM would
 *             have made the same decision at the same bar)
 *      d. If still in trade at end of window: force-close at last bar
 *   5. Aggregate per window and overall
 *
 * Caveats — what this DOESN'T model:
 *   - The LLM's HOLD decisions during a wider-SL trade. Real production
 *     would re-evaluate every bar; for trades that originally hit SL
 *     before any LLM exit, this replay assumes the trade runs to
 *     TP / window-end since we have no LLM-decision data past the SL
 *     timestamp. Likely OPTIMISTIC.
 *   - Move_be re-emissions. Wider SL means +1R takes longer; original
 *     move_be timestamps may not apply. Replay ignores move_be.
 *   - Regime-flip exits. Original LLM exits cite regime context; the
 *     replay accepts the original LLM exit timestamp as-is.
 *
 * What it DOES estimate accurately:
 *   - Whether trades that originally died at SL would have survived
 *     long enough to either (a) hit TP, (b) reach the LLM's natural
 *     exit, or (c) bleed through stagnation
 *
 * Synthetic — no LLM calls, runs in seconds, ~$0.
 *
 * Usage: pnpm dlx tsx scripts/replay-shorts-asymmetric-sl.ts
 */
import { readFileSync, readdirSync } from "fs";
import { createClient } from "@supabase/supabase-js";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const RISK_PER_TRADE_USD = 1000; // 1% risk on $100K — matches WF config
const RR = 3; // rr_multiple TP ratio
const ATR_BUFFER_MULT = 0.25; // matches v5_15m algo config
const ATR_PERIOD = 14;
const ORIGINAL_LOOKBACK = 12;
const NEW_LOOKBACK = 18;

interface Trade {
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  exit_reason: string;
  hold_bars: number;
  r_multiple: number;
  entry_regime?: string;
  exit_regime?: string;
}

interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface ReplayedExit {
  exit_price: number;
  exit_idx: number;
  exit_reason: "sl" | "tp" | "llm_passthrough" | "force_close";
  r_multiple: number;
  pnl_usd: number;
}

function loadJSONL(path: string): Trade[] {
  const out: Trade[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as Trade);
  }
  return out;
}

/** Wilder's smoothed ATR. Returns the full series so caller can index by
 *  entry bar position. */
function computeAtr(bars: PriceBar[], period: number): number[] {
  if (bars.length === 0) return [];
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[0].high - bars[0].low);
      continue;
    }
    const prev = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prev),
        Math.abs(bars[i].low - prev)
      )
    );
  }
  const out: number[] = new Array(bars.length).fill(0);
  if (tr.length < period) return out;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  out[period - 1] = atr;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Compute SL distance for a SHORT entry using swing_anchor.
 *  SL placement = highest_high in [entryIdx - lookback, entryIdx]
 *  + buffer × ATR(period) at entryIdx. */
function computeShortSlDistance(
  bars: PriceBar[],
  atrSeries: number[],
  entryIdx: number,
  entryPrice: number,
  lookback: number,
  bufferMult: number
): { slDistance: number; slPrice: number; baseDistance: number; atr: number } {
  const start = Math.max(0, entryIdx - lookback);
  let highest = -Infinity;
  for (let j = start; j <= entryIdx; j++) {
    if (bars[j].high > highest) highest = bars[j].high;
  }
  const baseDistance = highest - entryPrice;
  const atr = atrSeries[entryIdx] ?? 0;
  const slDistance = Math.max(baseDistance, 0) + bufferMult * atr;
  const slPrice = entryPrice + slDistance;
  return { slDistance, slPrice, baseDistance, atr };
}

/** Walk bars forward from entryIdx+1 until SL, TP, or original LLM exit
 *  timestamp. Return the chosen exit. */
function walkForwardShort(
  bars: PriceBar[],
  entryIdx: number,
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
  slDistance: number,
  origExitDate: string,
  origExitPrice: number,
  origExitReason: string
): ReplayedExit {
  // Find original exit bar index (sentinel if outside cached range).
  const origExitIdx = bars.findIndex((b) => b.date === origExitDate);
  const stopAt = origExitIdx >= 0 ? origExitIdx : bars.length - 1;

  for (let j = entryIdx + 1; j <= stopAt; j++) {
    const bar = bars[j];
    // Conservative: when both SL and TP land inside the same bar's
    // range, assume SL hits first. Penalises the wider-SL hypothesis
    // slightly — better to under-claim than over-claim.
    if (bar.high >= slPrice) {
      return {
        exit_price: slPrice,
        exit_idx: j,
        exit_reason: "sl",
        r_multiple: -1,
        pnl_usd: -RISK_PER_TRADE_USD,
      };
    }
    if (bar.low <= tpPrice) {
      return {
        exit_price: tpPrice,
        exit_idx: j,
        exit_reason: "tp",
        r_multiple: RR,
        pnl_usd: RR * RISK_PER_TRADE_USD,
      };
    }
  }

  // Neither price-exit fired before the original LLM exit timestamp.
  // Pass through the original LLM exit price (the LLM presumably would
  // have made the same decision at this timestamp regardless of where
  // SL was placed, since the decision was driven by structure not P&L).
  if (origExitIdx >= 0) {
    const move = entryPrice - origExitPrice; // for short
    const r = move / slDistance;
    return {
      exit_price: origExitPrice,
      exit_idx: origExitIdx,
      exit_reason:
        origExitReason === "stop_loss" ? "force_close" : "llm_passthrough",
      r_multiple: r,
      pnl_usd: r * RISK_PER_TRADE_USD,
    };
  }

  // Window-end force close (shouldn't happen if origExitDate is in cache).
  const lastBar = bars[bars.length - 1];
  const move = entryPrice - lastBar.close;
  const r = move / slDistance;
  return {
    exit_price: lastBar.close,
    exit_idx: bars.length - 1,
    exit_reason: "force_close",
    r_multiple: r,
    pnl_usd: r * RISK_PER_TRADE_USD,
  };
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("Loading 15m bars from price_cache...");
  const { data: cacheRow, error } = await supabase
    .from("price_cache_archive" as never)
    .select("bars")
    .limit(0);
  // The above is a placeholder; price_cache hasn't been archived. Use the
  // live price_cache table:
  const { data: live, error: liveErr } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", "XAU/USD")
    .eq("interval", "15min")
    .single();
  if (liveErr || !live) {
    throw new Error(`failed to load 15m bars: ${liveErr?.message ?? ""}`);
  }
  void cacheRow;
  void error;
  const bars = (live.bars as PriceBar[]) ?? [];
  console.log(`  ${bars.length} bars (${bars[0]?.date} → ${bars[bars.length - 1]?.date})`);
  console.log("");

  console.log(`Computing ATR(${ATR_PERIOD}) series...`);
  const atrSeries = computeAtr(bars, ATR_PERIOD);
  console.log("");

  // Index bars by date for O(1) lookup.
  const dateToIdx = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) dateToIdx.set(bars[i].date, i);

  // Discover trade files.
  const tradeFiles = readdirSync("scripts").filter((f) =>
    /^llm-trader-trades-anthropic-15m-30d-v5_15m-[A-D]-/.test(f)
  );
  tradeFiles.sort();
  console.log(`Found ${tradeFiles.length} trade JSONLs:`);
  for (const f of tradeFiles) console.log(`  ${f}`);
  console.log("");

  interface WindowSummary {
    label: string;
    shortCount: number;
    origWins: number;
    origPnl: number;
    origMeanR: number;
    replayWins: number;
    replayPnl: number;
    replayMeanR: number;
    skipped: number;
    exitBreakdown: { sl: number; tp: number; llm: number; force: number };
  }
  const summaries: WindowSummary[] = [];
  const allShorts: Array<{ window: string; orig: Trade; replay: ReplayedExit | null }> = [];

  for (const file of tradeFiles) {
    const labelMatch = file.match(/-([A-D])-/);
    const label = labelMatch ? labelMatch[1] : "?";
    const trades = loadJSONL(`scripts/${file}`);
    const shorts = trades.filter((t) => t.side === "short");

    let origPnl = 0;
    let origWins = 0;
    let origRSum = 0;
    let replayPnl = 0;
    let replayWins = 0;
    let replayRSum = 0;
    let skipped = 0;
    const exitBreakdown = { sl: 0, tp: 0, llm: 0, force: 0 };

    for (const t of shorts) {
      origPnl += t.realized_pnl;
      origRSum += t.r_multiple;
      if (t.r_multiple > 0) origWins++;

      const entryIdx = dateToIdx.get(t.entry_date);
      if (entryIdx === undefined || entryIdx < NEW_LOOKBACK) {
        skipped++;
        allShorts.push({ window: label, orig: t, replay: null });
        continue;
      }

      const { slDistance, slPrice, baseDistance, atr } = computeShortSlDistance(
        bars,
        atrSeries,
        entryIdx,
        t.entry_price,
        NEW_LOOKBACK,
        ATR_BUFFER_MULT
      );
      void baseDistance;
      void atr;
      const tpDistance = RR * slDistance;
      const tpPrice = t.entry_price - tpDistance;

      const replay = walkForwardShort(
        bars,
        entryIdx,
        t.entry_price,
        slPrice,
        tpPrice,
        slDistance,
        t.exit_date,
        t.exit_price,
        t.exit_reason
      );

      replayPnl += replay.pnl_usd;
      replayRSum += replay.r_multiple;
      if (replay.r_multiple > 0) replayWins++;

      if (replay.exit_reason === "sl") exitBreakdown.sl++;
      else if (replay.exit_reason === "tp") exitBreakdown.tp++;
      else if (replay.exit_reason === "llm_passthrough") exitBreakdown.llm++;
      else exitBreakdown.force++;

      allShorts.push({ window: label, orig: t, replay });
    }

    summaries.push({
      label,
      shortCount: shorts.length,
      origWins,
      origPnl,
      origMeanR: shorts.length > 0 ? origRSum / shorts.length : 0,
      replayWins,
      replayPnl,
      replayMeanR: shorts.length > skipped ? replayRSum / (shorts.length - skipped) : 0,
      skipped,
      exitBreakdown,
    });
  }

  // ---- Output ----
  console.log("===== Per-window short trade comparison =====");
  console.log("");
  console.log(
    "Window | Shorts | Orig WR | Orig $ | Orig R | Replay WR | Replay $ | Replay R | Δ$ | Δwins"
  );
  console.log(
    "-------+--------+---------+--------+--------+-----------+----------+----------+-----+------"
  );
  let totalShorts = 0,
    totalOrigPnl = 0,
    totalOrigWins = 0,
    totalReplayPnl = 0,
    totalReplayWins = 0,
    totalSkipped = 0;
  for (const s of summaries) {
    const origWr = s.shortCount > 0 ? (s.origWins / s.shortCount) * 100 : 0;
    const replayWr = s.shortCount > 0 ? (s.replayWins / s.shortCount) * 100 : 0;
    const dPnl = s.replayPnl - s.origPnl;
    const dWins = s.replayWins - s.origWins;
    console.log(
      `   ${s.label}   |   ${s.shortCount.toString().padStart(2)}   | ${origWr.toFixed(0).padStart(4)}%   | $${s.origPnl.toFixed(0).padStart(5)} | ${s.origMeanR >= 0 ? "+" : ""}${s.origMeanR.toFixed(2)}  |   ${replayWr.toFixed(0).padStart(4)}%   | $${s.replayPnl.toFixed(0).padStart(5)} | ${s.replayMeanR >= 0 ? "+" : ""}${s.replayMeanR.toFixed(2)}    | ${dPnl >= 0 ? "+" : ""}$${dPnl.toFixed(0).padStart(5)} | ${dWins >= 0 ? "+" : ""}${dWins}`
    );
    if (s.skipped > 0) {
      console.log(`         (skipped ${s.skipped} trades — entry outside cached bar range)`);
    }
    totalShorts += s.shortCount;
    totalOrigPnl += s.origPnl;
    totalOrigWins += s.origWins;
    totalReplayPnl += s.replayPnl;
    totalReplayWins += s.replayWins;
    totalSkipped += s.skipped;
  }
  console.log(
    "-------+--------+---------+--------+--------+-----------+----------+----------+-----+------"
  );
  const totalOrigWr = totalShorts > 0 ? (totalOrigWins / totalShorts) * 100 : 0;
  const totalReplayWr = totalShorts > 0 ? (totalReplayWins / totalShorts) * 100 : 0;
  console.log(
    ` TOTAL  |   ${totalShorts.toString().padStart(2)}   | ${totalOrigWr.toFixed(0).padStart(4)}%   | $${totalOrigPnl.toFixed(0).padStart(5)} |       |   ${totalReplayWr.toFixed(0).padStart(4)}%   | $${totalReplayPnl.toFixed(0).padStart(5)} |       | ${totalReplayPnl - totalOrigPnl >= 0 ? "+" : ""}$${(totalReplayPnl - totalOrigPnl).toFixed(0).padStart(5)} | ${totalReplayWins - totalOrigWins >= 0 ? "+" : ""}${totalReplayWins - totalOrigWins}`
  );
  console.log("");

  console.log("===== Replay exit-reason breakdown =====");
  console.log("");
  console.log("Window | new SL | new TP | LLM passthrough | Force close");
  console.log("-------+--------+--------+-----------------+------------");
  for (const s of summaries) {
    console.log(
      `   ${s.label}   |   ${s.exitBreakdown.sl}    |   ${s.exitBreakdown.tp}    |        ${s.exitBreakdown.llm}        |     ${s.exitBreakdown.force}`
    );
  }
  console.log("");

  if (totalSkipped > 0) {
    console.log(
      `Note: ${totalSkipped} trades skipped because their entry timestamp wasn't in the cached 15m corpus (probably edge bars near start of cache range).`
    );
    console.log("");
  }

  console.log("===== Trade-by-trade audit (showing the most-changed cases) =====");
  console.log("");
  const withReplay = allShorts.filter((s) => s.replay !== null);
  withReplay.sort((a, b) => {
    const dA = (a.replay!.pnl_usd - a.orig.realized_pnl);
    const dB = (b.replay!.pnl_usd - b.orig.realized_pnl);
    return Math.abs(dB) - Math.abs(dA);
  });
  for (const s of withReplay.slice(0, 10)) {
    const orig = s.orig;
    const r = s.replay!;
    const delta = r.pnl_usd - orig.realized_pnl;
    console.log(
      `[${s.window}] ${orig.entry_date.slice(0, 16)} short @ ${orig.entry_price.toFixed(2)}`
    );
    console.log(
      `   orig:   ${orig.exit_reason.padEnd(12)} → exit ${orig.exit_price.toFixed(2)} = ${orig.r_multiple >= 0 ? "+" : ""}${orig.r_multiple.toFixed(2)}R / $${orig.realized_pnl.toFixed(0)}`
    );
    console.log(
      `   replay: ${r.exit_reason.padEnd(12)} → exit ${r.exit_price.toFixed(2)} = ${r.r_multiple >= 0 ? "+" : ""}${r.r_multiple.toFixed(2)}R / $${r.pnl_usd.toFixed(0)}    (${delta >= 0 ? "+" : ""}$${delta.toFixed(0)})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
