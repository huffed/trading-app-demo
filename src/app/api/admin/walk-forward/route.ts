/**
 * Admin endpoint: run a walk-forward backtest on an algorithm and report
 * per-window stats so we can see whether the strategy's edge is robust
 * across regimes or just lucky on the long aggregate.
 *
 * Optionally compares the algorithm's current rules against a "filter
 * off" baseline by passing ?compare_regime_filter=1 — useful for
 * deciding whether a tweak like the ATR regime filter actually helps
 * across slid windows or just on a single 1y view.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/walk-forward?id=<algo>&window_days=60&step_days=30"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { runWalkForward, type WalkForwardSummary } from "@/lib/market-data/walk-forward";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  const windowDays = Number(url.searchParams.get("window_days") ?? "60");
  const stepDays = Number(url.searchParams.get("step_days") ?? "30");
  const compareFilter = url.searchParams.get("compare_regime_filter") === "1";
  if (!algoId) return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });
  if (!Number.isFinite(windowDays) || windowDays < 14) {
    return NextResponse.json({ error: "window_days must be >= 14" }, { status: 400 });
  }
  if (!Number.isFinite(stepDays) || stepDays < 1) {
    return NextResponse.json({ error: "step_days must be >= 1" }, { status: 400 });
  }

  // Lazy imports — keeps the route bundle slim when this endpoint isn't hit.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { timeframeToInterval } = await import("@/lib/market-data/interval");
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const { fetchEconomicCalendar } = await import("@/lib/market-data/economic-calendar");

  const supabase = createAdminClient();
  const algoRes = await supabase.from("algorithms").select("*").eq("id", algoId).single();
  const algo = algoRes.data as unknown as
    | { rules: import("@/types/algorithm").AlgorithmRules; capital: number }
    | null;
  if (algoRes.error || !algo) {
    return NextResponse.json({ error: "algorithm not found" }, { status: 404 });
  }

  const wlRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((r) => r.ticker.toUpperCase());
  if (tickers.length === 0) {
    return NextResponse.json({ error: "watchlist empty" }, { status: 400 });
  }

  const interval = timeframeToInterval(algo.rules.timeframe);
  const pricesByTicker = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, "full", interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, "full", interval);
        savePricesToCache(ticker, "full", prices, interval).catch(() => {});
      } catch {
        continue;
      }
    }
    if (prices && prices.length >= 30) pricesByTicker.set(ticker, prices);
  }

  let events: Awaited<ReturnType<typeof fetchEconomicCalendar>> = [];
  if (algo.rules.news_veto?.enabled) {
    let earliest = new Date();
    let latest = new Date(0);
    for (const prices of pricesByTicker.values()) {
      const a = new Date(prices[0].date);
      const b = new Date(prices[prices.length - 1].date);
      if (a < earliest) earliest = a;
      if (b > latest) latest = b;
    }
    events = await fetchEconomicCalendar(earliest, latest);
  }

  const opts = { testWindowDays: windowDays, stepDays, events };
  const current = runWalkForward(algo.rules, pricesByTicker, algo.capital, opts);

  let baseline: WalkForwardSummary | null = null;
  if (compareFilter) {
    // Run the same windows with the regime filter explicitly disabled,
    // regardless of what's set on the saved rules. Lets us isolate the
    // filter's contribution from any other config changes.
    const rulesNoFilter = {
      ...algo.rules,
      regime_filter: { ...(algo.rules.regime_filter ?? { enabled: false }), enabled: false },
    };
    baseline = runWalkForward(rulesNoFilter, pricesByTicker, algo.capital, opts);
  }

  return NextResponse.json({
    algorithm_id: algoId,
    config: { window_days: windowDays, step_days: stepDays, tickers },
    current,
    baseline_no_filter: baseline,
  });
}
