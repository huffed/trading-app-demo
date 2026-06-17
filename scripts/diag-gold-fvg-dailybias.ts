/**
 * Diagnostic: walk Gold FVG-DailyBias-Long 4h bar-by-bar, report:
 *   - count of bars where FVG-bullish condition true
 *   - count of bars where daily_bias-bullish true
 *   - count of bars where BOTH true (would-be entries)
 *   - of those, how many pass the always-on intraday ATR liquidity gate
 *   - of those, how many produce a positive sizing decision
 *
 * Compares the same path to USD/JPY (same template) as a sanity baseline.
 *
 * Usage:
 *   pnpm dlx tsx scripts/diag-gold-fvg-dailybias.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { checkConditions } from "../src/lib/market-data/backtest-engine";
import { resampleToDaily } from "../src/lib/market-data/resample";
import { checkAtrLiquidity } from "../src/lib/algorithm/intraday-atr-gate";
import { computeSlDistance } from "../src/lib/algorithm/structural-sl";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { getCachedPrices } from "../src/lib/market-data/price-cache";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, PatternCondition } from "../src/types/algorithm";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

async function diag(name: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase
    .from("algorithms")
    .select("rules, capital")
    .eq("name", name)
    .single();
  const rules = (algoRes.data as unknown as { rules: AlgorithmRules }).rules;

  const wl = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", (algoRes.data as unknown as { id: string }).id ?? "");
  const ticker = (wl.data as { ticker: string }[] | null)?.[0]?.ticker ?? "";

  const tickerFromName = name.includes("USD/JPY") ? "USD/JPY" : name.includes("Gold") ? "XAU/USD" : ticker;
  const interval = timeframeToInterval(rules.timeframe);
  const bars: PriceBar[] | null = await getCachedPrices(tickerFromName, "full", interval);
  if (!bars || bars.length < 30) {
    console.log(`  ! no bars for ${tickerFromName} ${interval}`);
    return;
  }
  const dailyBars = resampleToDaily(bars);
  const closes = bars.map((b) => b.close);

  console.log(`\n===== ${name} =====`);
  console.log(`  ticker: ${tickerFromName}, bars: ${bars.length}, daily: ${dailyBars.length}`);

  const fvgCond = rules.entry_conditions.find(
    (c) => c.type === "pattern" && (c as PatternCondition).pattern === "fvg"
  ) as PatternCondition | undefined;
  const biasCond = rules.entry_conditions.find(
    (c) => c.type === "pattern" && (c as PatternCondition).pattern === "daily_bias"
  ) as PatternCondition | undefined;

  let nFvg = 0,
    nBias = 0,
    nBoth = 0,
    nPassAtr = 0,
    nPassSizing = 0,
    nSlZero = 0;
  const examples: string[] = [];

  for (let i = 30; i < bars.length; i++) {
    const ctx = {
      cache: new Map(),
      closes,
      bars,
      higherTfBars: dailyBars,
      i,
      news_events: [],
      relevant_currencies: [],
    };
    const fvgFired = fvgCond ? checkConditions([fvgCond], ctx, "all") : false;
    const biasFired = biasCond ? checkConditions([biasCond], ctx, "all") : false;
    if (fvgFired) nFvg++;
    if (biasFired) nBias++;
    if (!fvgFired || !biasFired) continue;
    nBoth++;

    const atrCheck = checkAtrLiquidity(bars, i);
    if (atrCheck.skip) continue;
    nPassAtr++;

    const entryPrice = bars[i].close;
    const slDistance = computeSlDistance(rules.stop_loss, "long", entryPrice, tickerFromName, bars, i);
    if (slDistance <= 0) {
      nSlZero++;
      if (examples.length < 3)
        examples.push(`  ! slDistance=0 at ${bars[i].date}: entry=${entryPrice}, low4=${bars.slice(Math.max(0, i - 4), i + 1).reduce((m, b) => Math.min(m, b.low), Infinity)}`);
      continue;
    }
    nPassSizing++;
  }

  console.log(`  FVG-bullish bars:        ${nFvg}`);
  console.log(`  daily_bias-bullish bars: ${nBias}`);
  console.log(`  BOTH (would-be entries): ${nBoth}`);
  console.log(`  pass ATR liquidity:      ${nPassAtr}`);
  console.log(`  slDistance > 0:          ${nPassSizing}`);
  console.log(`  slDistance == 0 reject:  ${nSlZero}`);
  examples.forEach((e) => console.log(e));
}

async function main(): Promise<void> {
  await diag("Library: Gold FVG-DailyBias-Long 4h");
  await diag("Library: USD/JPY FVG-DailyBias-Long 4h");
}

void main();
