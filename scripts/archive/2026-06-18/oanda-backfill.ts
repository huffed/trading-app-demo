/**
 * OANDA backfill — populate price_cache with deep historical XAU/USD bars
 * via the OANDA REST v20 practice API.
 *
 * Why: Twelve Data free caps intraday fetches at 5000 bars (~52 days on
 * 30m). Multi-algo backtest validation across historical regimes (Oct
 * 2024 trend, Dec 2024 drawdown, Feb 2025 trend) needs deeper history.
 * OANDA practice API gives 5+ years on metals at no cost.
 *
 * Run:
 *   pnpm dlx tsx scripts/oanda-backfill.ts
 *
 * Env (required):
 *   OANDA_API_KEY                    — practice token
 *   NEXT_PUBLIC_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY        — service-role key (server-side write)
 *
 * Env (optional):
 *   OANDA_INSTRUMENT=XAU_USD         — default XAU_USD
 *   OANDA_GRANULARITY=M30            — OANDA code (M30 / H1 / H4 etc)
 *   CACHE_INTERVAL=30min             — interval column value in price_cache
 *   CACHE_TICKER=XAU/USD             — ticker column value (matches harness)
 *   FROM_DATE=2024-01-01             — UTC start
 *   TO_DATE=                         — UTC end (default: now)
 *   DRY_RUN=1                        — don't write to Supabase
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// --- env loader (matches the pattern in llm-trader-backtest.ts) ---
try {
  const envText = readFileSync("/Users/jack.jones/Documents/trading-app/demo-1/.env.local", "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) {
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  }
} catch {
  // ignore — assume env already set
}

const TOKEN = process.env.OANDA_API_KEY;
const INSTRUMENT = process.env.OANDA_INSTRUMENT ?? "XAU_USD";
const GRANULARITY = process.env.OANDA_GRANULARITY ?? "M30";
const CACHE_INTERVAL = process.env.CACHE_INTERVAL ?? "30min";
const CACHE_TICKER = process.env.CACHE_TICKER ?? "XAU/USD";
const FROM_DATE = process.env.FROM_DATE ?? "2024-01-01";
const TO_DATE = process.env.TO_DATE ?? new Date().toISOString().slice(0, 10);
const DRY_RUN = process.env.DRY_RUN === "1";

if (!TOKEN) {
  console.error("OANDA_API_KEY not set");
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid: { o: string; h: string; l: string; c: string };
}

interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function oandaToBar(c: OandaCandle): PriceBar {
  return {
    date: c.time.slice(0, 19).replace("T", " "),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: c.volume,
  };
}

async function fetchChunk(fromIso: string, count: number): Promise<OandaCandle[]> {
  const url = `https://api-fxpractice.oanda.com/v3/instruments/${INSTRUMENT}/candles?granularity=${GRANULARITY}&from=${encodeURIComponent(fromIso)}&count=${count}&price=M`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    throw new Error(`OANDA HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { candles: OandaCandle[] };
  return data.candles;
}

async function main(): Promise<void> {
  console.log(`OANDA backfill — ${INSTRUMENT} ${GRANULARITY}`);
  console.log(`  cache key: ticker='${CACHE_TICKER}' interval='${CACHE_INTERVAL}'`);
  console.log(`  range: ${FROM_DATE} → ${TO_DATE}`);
  console.log(`  dry run: ${DRY_RUN}`);
  console.log("");

  const toMs = new Date(`${TO_DATE}T23:59:59Z`).getTime();
  let cursorIso = `${FROM_DATE}T00:00:00Z`;
  const allBars: PriceBar[] = [];
  let chunkNum = 0;
  const seenTimes = new Set<string>();

  while (true) {
    chunkNum++;
    process.stdout.write(`  chunk ${chunkNum} from ${cursorIso}... `);
    const candles = await fetchChunk(cursorIso, 5000);
    if (candles.length === 0) {
      console.log(`empty — done`);
      break;
    }
    let added = 0;
    let lastTimeMs = 0;
    for (const c of candles) {
      if (!c.complete) continue; // skip currently-forming bar
      const tMs = new Date(c.time).getTime();
      if (tMs > toMs) continue; // beyond requested window
      if (seenTimes.has(c.time)) continue;
      seenTimes.add(c.time);
      allBars.push(oandaToBar(c));
      added++;
      lastTimeMs = tMs;
    }
    console.log(`${candles.length} candles, ${added} new (last ${candles[candles.length - 1].time})`);
    if (lastTimeMs >= toMs) break;
    if (added === 0) break; // no progress — bail
    cursorIso = new Date(lastTimeMs + 1000).toISOString();
    // tiny pause so we're nice to OANDA's rate limiter
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("");
  console.log(`Fetched ${allBars.length} bars`);
  if (allBars.length === 0) {
    console.log("Nothing to write");
    return;
  }
  console.log(`  earliest: ${allBars[0].date}`);
  console.log(`  latest:   ${allBars[allBars.length - 1].date}`);

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — not writing to Supabase");
    return;
  }

  const supabase = createClient(supabaseUrl as string, serviceKey as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // price_cache is now global (user_id column dropped in migration 00037).
  // Unique constraint is on (ticker, output_size, interval).
  const { error } = await supabase.from("price_cache").upsert(
    {
      ticker: CACHE_TICKER,
      interval: CACHE_INTERVAL,
      output_size: "full",
      bars: allBars,
      bar_count: allBars.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "ticker,output_size,interval" }
  );

  if (error) {
    console.error("Supabase upsert failed:", error);
    process.exit(1);
  }
  console.log(`Wrote ${allBars.length} bars to price_cache`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
