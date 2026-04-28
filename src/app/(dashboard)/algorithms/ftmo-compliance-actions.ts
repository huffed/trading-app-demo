"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";
import type {
  ComplianceGauge,
  DivergenceState,
  FtmoCompliance,
  HaltEvent,
} from "@/types/ftmo-compliance";

interface AlgoRow {
  id: string;
  capital: number;
  rules: AlgorithmRules;
}

interface ClosedTodayRow {
  realized_pnl: number | null;
}
interface OpenRow {
  unrealized_pnl: number | null;
}
interface PnlRow {
  realized_pnl: number | null;
}
interface FillRow {
  entry_price: number;
  broker_fill_price: number | null;
}
interface ActivityRow {
  event_type: string;
  created_at: string;
  details: Record<string, unknown> | null;
}

function gaugeState(valuePct: number, thresholdPct: number): ComplianceGauge["state"] {
  const used = valuePct / thresholdPct;
  if (used >= 1) return "breach";
  if (used >= 0.8) return "warn";
  return "ok";
}

function startOfTodayUtcIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

interface AggregateInputs {
  closedToday: ClosedTodayRow[];
  openNow: OpenRow[];
  allClosed: PnlRow[];
}

function computeGauges(
  inputs: AggregateInputs,
  capital: number,
  pf: NonNullable<AlgorithmRules["prop_firm"]>
) {
  const realizedToday = inputs.closedToday.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
  const unrealizedNow = inputs.openNow.reduce((s, r) => s + (r.unrealized_pnl ?? 0), 0);
  const totalRealized = inputs.allClosed.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
  const totalEquityChangePct =
    capital > 0 ? ((totalRealized + unrealizedNow) / capital) * 100 : 0;
  const todaysPnlPct =
    capital > 0 ? ((realizedToday + unrealizedNow) / capital) * 100 : 0;
  const dailyHaltPct = (pf.daily_loss_halt_pct ?? 100) / 100;
  const dailyThresholdPct = pf.daily_loss_limit * dailyHaltPct;
  const dailyValuePct = todaysPnlPct < 0 ? -todaysPnlPct : 0;
  const drawdownValuePct = totalEquityChangePct < 0 ? -totalEquityChangePct : 0;
  const profitValuePct = totalEquityChangePct > 0 ? totalEquityChangePct : 0;

  return {
    daily_pnl: {
      label: "Today's loss",
      value_pct: Number(dailyValuePct.toFixed(2)),
      threshold_pct: Number(dailyThresholdPct.toFixed(2)),
      state: gaugeState(dailyValuePct, dailyThresholdPct),
    },
    drawdown: {
      label: "Drawdown",
      value_pct: Number(drawdownValuePct.toFixed(2)),
      threshold_pct: pf.max_drawdown,
      state: gaugeState(drawdownValuePct, pf.max_drawdown),
    },
    profit_target: {
      label: "Profit target",
      value_pct: Number(profitValuePct.toFixed(2)),
      threshold_pct: pf.profit_target,
      state: (profitValuePct >= pf.profit_target ? "breach" : "ok") as "breach" | "ok",
    },
  };
}

async function fetchComplianceData(
  supabase: Awaited<ReturnType<typeof getAuthedUser>>["supabase"],
  userId: string,
  algorithmId: string
) {
  const startIso = startOfTodayUtcIso();
  return Promise.all([
    supabase
      .from("paper_positions")
      .select("realized_pnl")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", userId)
      .eq("status", "closed")
      .gte("closed_at", startIso),
    supabase
      .from("paper_positions")
      .select("unrealized_pnl")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", userId)
      .eq("status", "open"),
    supabase
      .from("paper_positions")
      .select("realized_pnl")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", userId)
      .eq("status", "closed"),
    supabase
      .from("paper_positions")
      .select("entry_price, broker_fill_price")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", userId)
      .not("broker_fill_price", "is", null)
      .order("opened_at", { ascending: false })
      .limit(50),
    supabase
      .from("activity_log")
      .select("event_type, created_at, details")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", userId)
      .in("event_type", ["daily_loss_halt", "divergence_halt"])
      .order("created_at", { ascending: false })
      .limit(5),
  ]);
}

const EMPTY_COMPLIANCE: FtmoCompliance = {
  has_prop_firm: false,
  daily_pnl: null,
  drawdown: null,
  profit_target: null,
  divergence: null,
  recent_halts: [],
};

/**
 * Build the live FTMO compliance snapshot for an algorithm. Pulls from
 * paper_positions + activity_log; no broker-side calls so safe to refetch
 * frequently. Returns nulls for gauges when the algo has no prop_firm rule.
 */
export async function getFtmoCompliance(
  algorithmId: string
): Promise<ActionResult<FtmoCompliance>> {
  try {
    const { supabase, user } = await getAuthedUser();

    const { data: algoData, error: algoErr } = await supabase
      .from("algorithms")
      .select("id, capital, rules")
      .eq("id", algorithmId)
      .eq("user_id", user.id)
      .single();
    if (algoErr || !algoData) {
      return { success: false, error: algoErr?.message ?? "Algorithm not found" };
    }
    const algo = algoData as unknown as AlgoRow;
    const pf = algo.rules.prop_firm;
    if (!pf) return { success: true, data: EMPTY_COMPLIANCE };

    const [closedTodayRes, openRes, allClosedRes, fillRowsRes, haltsRes] =
      await fetchComplianceData(supabase, user.id, algorithmId);

    const gauges = computeGauges(
      {
        closedToday: (closedTodayRes.data ?? []) as ClosedTodayRow[],
        openNow: (openRes.data ?? []) as OpenRow[],
        allClosed: (allClosedRes.data ?? []) as PnlRow[],
      },
      algo.capital,
      pf
    );

    const divergence = computeDivergence(
      (fillRowsRes.data ?? []) as FillRow[],
      algo.rules.divergence_kill
    );
    const recent_halts = ((haltsRes.data ?? []) as ActivityRow[]).map((r) => ({
      event_type: r.event_type,
      created_at: r.created_at,
      details: r.details ?? {},
    })) as HaltEvent[];

    return {
      success: true,
      data: { has_prop_firm: true, ...gauges, divergence, recent_halts },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load compliance";
    return { success: false, error: msg };
  }
}

function computeDivergence(
  fills: FillRow[],
  rule: AlgorithmRules["divergence_kill"]
): DivergenceState | null {
  if (!rule) return null;
  const eligible = fills.filter(
    (r) => r.broker_fill_price != null && r.entry_price > 0
  );
  const samples = Math.min(eligible.length, rule.window_trades);
  let avg_bps = NaN;
  if (samples >= rule.window_trades) {
    let sum = 0;
    for (let i = 0; i < rule.window_trades; i++) {
      const r = eligible[i];
      const bps = (Math.abs((r.broker_fill_price ?? 0) - r.entry_price) / r.entry_price) * 10000;
      sum += bps;
    }
    avg_bps = sum / rule.window_trades;
  }
  return {
    samples,
    required_samples: rule.window_trades,
    avg_bps,
    threshold_bps: rule.max_avg_bps,
    is_armed: !isNaN(avg_bps) && avg_bps > rule.max_avg_bps,
  };
}
