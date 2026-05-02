/**
 * Live operations dashboard. Run anytime to get a single-page view of:
 *   - Active algos: status, last_scanned_at, broker connection
 *   - Today's P&L per algo vs DLL halt + warn thresholds
 *   - Recent LLM decisions per algo (count + distribution)
 *   - Recent trades (last 7 days, P&L)
 *   - Drift detector status per algo
 *   - Recent activity_log warnings + halts
 *   - Cron health (gap since last scan_completed)
 *
 * Designed for "first thing Monday morning" review — see live state at
 * a glance without writing SQL on the fly.
 *
 * Usage:
 *   pnpm dlx tsx scripts/monitor-live.ts
 *
 * Env (optional):
 *   HOURS=24             lookback for recent decisions/activity (default 24)
 *   TRADE_DAYS=7         lookback for closed trades (default 7)
 *   ALGO_ID=<uuid>       restrict output to one algo (default: all active)
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { detectDrift, DEFAULT_DRIFT_CONFIG } from "../src/lib/scan/drift-detector";
import { checkDailyLossHalt } from "../src/lib/scan/daily-halt";
import type { AlgorithmRules, BacktestResults } from "../src/types/algorithm";

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

interface AlgorithmRow {
  id: string;
  name: string;
  status: string;
  live_trading_enabled: boolean;
  capital: number;
  broker_connection_id: string | null;
  rules: AlgorithmRules;
  backtest_results: BacktestResults | null;
  last_scanned_at: string | null;
}

const HORIZONTAL_RULE = "─".repeat(72);
const SECTION_RULE = "═".repeat(72);

function fmtTs(iso: string | null): string {
  if (!iso) return "(never)";
  const d = new Date(iso);
  const now = Date.now();
  const ageMin = Math.round((now - d.getTime()) / 60000);
  const ageStr =
    ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago` : `${Math.round(ageMin / 1440)}d ago`;
  return `${iso.slice(0, 16).replace("T", " ")} UTC (${ageStr})`;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(0)}`;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const hours = Number(process.env.HOURS ?? "24");
  const tradeDays = Number(process.env.TRADE_DAYS ?? "7");
  const onlyAlgoId = process.env.ALGO_ID;
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const tradeSinceIso = new Date(Date.now() - tradeDays * 86400 * 1000).toISOString();

  console.log(SECTION_RULE);
  console.log(`LIVE TRADING DASHBOARD · ${new Date().toISOString().slice(0, 19)}Z`);
  console.log(`Lookback: ${hours}h decisions / ${tradeDays}d trades`);
  console.log(SECTION_RULE);

  // 1. Cron health
  const { data: lastScan } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("event_type", "scan_completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .single<{ created_at: string }>();
  const { data: lastManage } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("event_type", "manage_tick")
    .order("created_at", { ascending: false })
    .limit(1)
    .single<{ created_at: string }>();
  console.log("\nCRON HEALTH");
  console.log(HORIZONTAL_RULE);
  console.log(`  Last scan_completed:  ${fmtTs(lastScan?.created_at ?? null)}`);
  console.log(`  Last manage_tick:     ${fmtTs(lastManage?.created_at ?? null)}`);
  console.log(`    (manage_tick only logged when ≥1 open position exists; absence = no positions, not dead cron)`);
  if (lastScan?.created_at) {
    const ageMin = Math.round((Date.now() - new Date(lastScan.created_at).getTime()) / 60000);
    if (ageMin > 30) console.log(`  ⚠  Scan stale: ${ageMin}m since last scan_completed (cron should fire every 15m)`);
  } else {
    console.log(`  ⚠  No scan_completed events found — scan cron may be dead`);
  }

  // 2. Active algos
  const algoQuery = supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, capital, broker_connection_id, rules, backtest_results, last_scanned_at")
    .eq("status", "active")
    .eq("live_trading_enabled", true);
  if (onlyAlgoId) algoQuery.eq("id", onlyAlgoId);
  const { data: algos } = await algoQuery;
  const activeAlgos = (algos ?? []) as AlgorithmRow[];

  console.log(`\nACTIVE ALGOS (${activeAlgos.length})`);
  console.log(HORIZONTAL_RULE);
  if (activeAlgos.length === 0) {
    console.log("  (none — no live trading active)");
  }

  for (const algo of activeAlgos) {
    console.log(`\n  ▶ ${algo.name} (${algo.id.slice(0, 8)})`);
    const tf = algo.rules.timeframe ?? "?";
    const promptVer = algo.rules.llm_trader?.prompt_version ?? "?";
    const risk = algo.rules.position_sizing?.value ?? 0;
    const maxPos = algo.rules.max_positions ?? 0;
    console.log(`    config: ${tf} · prompt ${promptVer} · ${risk}% risk · max ${maxPos} pos`);
    console.log(`    capital: $${algo.capital.toLocaleString()} · broker: ${algo.broker_connection_id?.slice(0, 8) ?? "(none)"}`);
    console.log(`    last_scanned_at: ${fmtTs(algo.last_scanned_at)}`);

    // Today's P&L vs DLL
    const dll = algo.rules.prop_firm?.daily_loss_limit;
    if (dll) {
      const check = await checkDailyLossHalt(
        supabase,
        algo.id,
        algo.capital,
        dll,
        algo.rules.prop_firm?.daily_loss_halt_pct ?? 100
      );
      const haltAt = -dll * ((algo.rules.prop_firm?.daily_loss_halt_pct ?? 100) / 100);
      const warnAt = -dll * 0.4; // matches DLL_WARN_PCT in daily-halt.ts
      const status =
        check.todaysPnlPct <= haltAt ? "🛑 HALT TRIPPED"
        : check.todaysPnlPct <= warnAt ? "⚠  WARN ZONE"
        : "✓ OK";
      console.log(
        `    today: ${fmtPnl(check.realized + check.unrealized)} (${check.todaysPnlPct.toFixed(2)}%) ` +
        `· warn=${warnAt.toFixed(1)}% · halt=${haltAt.toFixed(1)}% · ${status}`
      );
    }

    // Drift status
    const baseline = algo.backtest_results;
    if (baseline) {
      const driftConfig = {
        ...DEFAULT_DRIFT_CONFIG,
        minLiveWrPct: algo.rules.drift?.min_live_wr_pct,
      };
      const drift = await detectDrift(supabase, algo.id, baseline, driftConfig);
      const driftIcon = drift.severity === "halt" ? "🛑" : drift.severity === "warn" ? "⚠ " : "✓";
      console.log(
        `    drift: ${driftIcon} ${drift.severity.toUpperCase()} · recent ${drift.recent.win_rate.toFixed(0)}% WR ` +
        `· baseline ${(drift.baseline.win_rate ?? 0).toFixed(0)}% · ${drift.recent.trades} trades`
      );
      if (drift.severity !== "none") console.log(`      → ${drift.reason}`);
    }

    // Recent LLM decisions — LIVE only (exclude walk_forward / backtest)
    const { data: decisions } = await supabase
      .from("llm_decisions")
      .select("decision, confidence, regime, created_at")
      .eq("algorithm_id", algo.id)
      .eq("source", "live")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false });
    const decisionList = (decisions ?? []) as { decision: string; confidence: number; regime: string }[];
    if (decisionList.length > 0) {
      const dist: Record<string, number> = {};
      for (const d of decisionList) dist[d.decision] = (dist[d.decision] ?? 0) + 1;
      const distStr = Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(" · ");
      console.log(`    decisions (${hours}h): ${decisionList.length} total · ${distStr}`);
    } else {
      console.log(`    decisions (${hours}h): (none)`);
    }

    // Open + recent positions
    const { data: positions } = await supabase
      .from("paper_positions")
      .select("status, side, realized_pnl, unrealized_pnl, exit_reason, opened_at, closed_at")
      .eq("algorithm_id", algo.id)
      .gte("opened_at", tradeSinceIso)
      .order("opened_at", { ascending: false });
    const posList = (positions ?? []) as {
      status: string;
      side: string;
      realized_pnl: number | null;
      unrealized_pnl: number | null;
      exit_reason: string | null;
    }[];
    const open = posList.filter((p) => p.status === "open");
    const closed = posList.filter((p) => p.status === "closed");
    const closedPnl = closed.reduce((s, p) => s + (p.realized_pnl ?? 0), 0);
    const openPnl = open.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);
    const wins = closed.filter((p) => (p.realized_pnl ?? 0) > 0).length;
    const wr = closed.length > 0 ? (100 * wins) / closed.length : 0;
    console.log(
      `    positions (${tradeDays}d): ${open.length} open (${fmtPnl(openPnl)}) · ` +
      `${closed.length} closed (${wins}W / ${closed.length - wins}L · ${wr.toFixed(0)}% WR · ${fmtPnl(closedPnl)})`
    );
    if (closed.length > 0) {
      const exitDist: Record<string, number> = {};
      for (const p of closed) exitDist[p.exit_reason ?? "?"] = (exitDist[p.exit_reason ?? "?"] ?? 0) + 1;
      const exitStr = Object.entries(exitDist).map(([k, v]) => `${k}=${v}`).join(" · ");
      console.log(`      exit reasons: ${exitStr}`);
    }
  }

  // 3. Halts + warnings (last 24h)
  console.log(`\nHALTS + WARNINGS (last ${hours}h)`);
  console.log(HORIZONTAL_RULE);
  const { data: halts } = await supabase
    .from("activity_log")
    .select("event_type, created_at, details")
    .in("event_type", ["daily_loss_halt", "drift_halt", "drift_warn", "dll_warning", "consec_loss_halt"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  const haltList = (halts ?? []) as { event_type: string; created_at: string; details: Record<string, unknown> }[];
  if (haltList.length === 0) {
    console.log("  (none)");
  } else {
    for (const h of haltList) {
      const reason = h.details.reason ?? h.details.message ?? JSON.stringify(h.details).slice(0, 80);
      console.log(`  ${h.event_type.padEnd(20)} ${h.created_at.slice(0, 16).replace("T", " ")} UTC  ${reason}`);
    }
  }

  console.log(`\n${SECTION_RULE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
