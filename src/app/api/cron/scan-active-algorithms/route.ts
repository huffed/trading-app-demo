/**
 * Cron entrypoint: scan every active + live-trading-enabled algorithm.
 *
 * Auth: Bearer ${CRON_SECRET} header. Vercel Cron sends this automatically
 * when you set the secret in Vercel project env. Manual invocations need
 * the same header.
 *
 * Uses the service-role admin client because cron has no user session.
 * RLS is bypassed by the admin client, but each scanAlgorithm call is
 * scoped to the algorithm's owner user_id — paper_positions writes still
 * land on the right user.
 */
import { NextResponse } from "next/server";
import { scanAlgorithm, type ScanResult } from "@/lib/scan/engine";
import {
  checkPortfolioHalt,
  executePortfolioHalt,
} from "@/lib/scan/portfolio-halt";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AlgorithmRules } from "@/types/algorithm";
import type { Portfolio } from "@/types/portfolio";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface AlgoRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
  status: string;
  live_trading_enabled: boolean | null;
  broker_connection_id: string | null;
  portfolio_id: string | null;
  algorithm_watchlist: { ticker: string; name: string; auto_paused?: boolean }[] | null;
}

/**
 * Group active algos by portfolio (or "no portfolio" → null bucket) and
 * fire the portfolio-level halt check before any per-algo scan. Returns
 * the set of algorithm IDs that have been halted by the portfolio check
 * — those should NOT be scanned individually.
 */
async function applyPortfolioHalts(
  supabase: ReturnType<typeof createAdminClient>,
  algos: AlgoRow[]
): Promise<Set<string>> {
  const halted = new Set<string>();
  const byPortfolio = new Map<string, AlgoRow[]>();
  for (const a of algos) {
    if (!a.portfolio_id) continue;
    const list = byPortfolio.get(a.portfolio_id) ?? [];
    list.push(a);
    byPortfolio.set(a.portfolio_id, list);
  }
  if (byPortfolio.size === 0) return halted;

  const ids = Array.from(byPortfolio.keys());
  const { data } = await supabase.from("portfolios").select("*").in("id", ids);
  const portfolios = (data ?? []) as unknown as Portfolio[];

  for (const portfolio of portfolios) {
    const portfolioAlgos = byPortfolio.get(portfolio.id) ?? [];
    const algoIds = portfolioAlgos.map((a) => a.id);
    const haltCheck = await checkPortfolioHalt(supabase, portfolio, algoIds);
    if (haltCheck?.tripped) {
      // user_id is consistent across a portfolio's algos (RLS on portfolios).
      const userId = portfolioAlgos[0]?.user_id;
      if (userId) {
        await executePortfolioHalt(supabase, userId, portfolio, algoIds, haltCheck);
      }
      for (const id of algoIds) halted.add(id);
    }
  }
  return halted;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Status=active is the only requirement to scan; live_trading_enabled
  // gates broker mirroring inside the scan but doesn't gate the scan
  // itself. That way paper-only algos still run (and accumulate stats
  // for the drift detector / pair-pruner) when no broker is connected.
  const { data, error } = await supabase
    .from("algorithms")
    .select(
      "id, user_id, name, description, rules, capital, status, live_trading_enabled, broker_connection_id, portfolio_id, algorithm_watchlist(ticker, name, auto_paused)"
    )
    .eq("status", "active");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const algos = (data ?? []) as unknown as AlgoRow[];
  if (algos.length === 0) {
    return NextResponse.json({ scanned: 0, results: [] });
  }

  // Portfolio-level halts fire BEFORE individual scans so a losing day on
  // one algo flattens its portfolio peers before they take more positions.
  const haltedByPortfolio = await applyPortfolioHalts(supabase, algos);

  const results: (ScanResult | { algorithm_id: string; error: string })[] = [];
  for (const algo of algos) {
    if (haltedByPortfolio.has(algo.id)) {
      results.push({ algorithm_id: algo.id, error: "portfolio_halt" });
      continue;
    }
    try {
      const result = await scanAlgorithm(supabase, algo.user_id, {
        id: algo.id,
        name: algo.name,
        description: algo.description,
        rules: algo.rules,
        capital: algo.capital,
        status: algo.status,
        live_trading_enabled: algo.live_trading_enabled ?? false,
        broker_connection_id: algo.broker_connection_id,
        algorithm_watchlist: algo.algorithm_watchlist ?? [],
      });
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scan failed";
      results.push({ algorithm_id: algo.id, error: msg });
    }
  }

  return NextResponse.json({
    scanned: algos.length,
    portfolio_halts: haltedByPortfolio.size,
    results,
  });
}
