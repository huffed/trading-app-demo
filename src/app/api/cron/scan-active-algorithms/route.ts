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
import { createAdminClient } from "@/lib/supabase/admin";
import type { AlgorithmRules } from "@/types/algorithm";

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
  algorithm_watchlist: { ticker: string; name: string }[] | null;
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

  const { data, error } = await supabase
    .from("algorithms")
    .select(
      "id, user_id, name, description, rules, capital, status, live_trading_enabled, broker_connection_id, algorithm_watchlist(ticker, name)"
    )
    .eq("status", "active")
    .eq("live_trading_enabled", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const algos = (data ?? []) as unknown as AlgoRow[];
  if (algos.length === 0) {
    return NextResponse.json({ scanned: 0, results: [] });
  }

  const results: (ScanResult | { algorithm_id: string; error: string })[] = [];
  for (const algo of algos) {
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

  return NextResponse.json({ scanned: algos.length, results });
}
