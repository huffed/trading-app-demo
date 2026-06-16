/**
 * Engine activity — pure server-side aggregation over the last N days
 * of llm_decisions + activity_log. Powers both the CLI cohort report
 * (`scripts/cohort-report.ts`) and the in-UI /reports page.
 *
 * No FS I/O, no logging — the caller decides how to surface the data.
 *
 * Always informative even with zero closed trades: shows what the
 * engine has DECIDED (LLM hold/enter distribution + avg confidence) and
 * what it has REFUSED per algo (gate refusals / condition misses /
 * drift refusals / staleness blocks / hold counts). Plus the "notable
 * saves" — drift-refusal events where the gate caught a stale-price
 * entry the LLM wanted to take.
 *
 * Why a 7-day default: matches operator's weekly review cadence; long
 * enough to accumulate signal across daily-cron passes, short enough
 * that a recent config change shows distinctively in the next read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AlgoActivity {
  algorithm_id: string;
  name: string;
  evaluations: number;
  gate_refusals: number;
  condition_misses: number;
  drift_refusals: number;
  bar_staleness_refusals: number;
  llm_holds: number;
  other_refusals: number;
  fires: number;
}

export interface NotableSave {
  when: string;
  algorithm: string;
  reason: string;
  confidence: number | null;
  would_have_entered_side: string | null;
  llm_reasoning: string | null;
}

export interface EngineActivity {
  window_days: number;
  since: string; // ISO timestamp the window starts at
  llm_decisions: number;
  llm_avg_confidence: number | null;
  llm_by_decision: Record<string, number>;
  llm_by_mtf: Record<string, number>;
  per_algo: AlgoActivity[];
  notable_saves: NotableSave[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

interface DecisionRow {
  decision: string;
  confidence: number | null;
  context: Record<string, unknown> | null;
  created_at: string;
}

interface DecisionSummary {
  total: number;
  avgConfidence: number | null;
  byDecision: Record<string, number>;
  byMtf: Record<string, number>;
}

function summarizeDecisions(rows: DecisionRow[]): DecisionSummary {
  const byDecision: Record<string, number> = {};
  const byMtf: Record<string, number> = {};
  let confSum = 0;
  let confN = 0;
  for (const r of rows) {
    const dec = r.decision ?? "unknown";
    byDecision[dec] = (byDecision[dec] ?? 0) + 1;
    const mtfFromCtx = (r.context?.market_state as Record<string, unknown> | undefined)?.mtf;
    const mtfStr = typeof mtfFromCtx === "string" ? mtfFromCtx : "n/a";
    byMtf[mtfStr] = (byMtf[mtfStr] ?? 0) + 1;
    if (typeof r.confidence === "number") {
      confSum += r.confidence;
      confN++;
    }
  }
  return {
    total: rows.length,
    avgConfidence: confN > 0 ? Number((confSum / confN).toFixed(1)) : null,
    byDecision,
    byMtf,
  };
}

function bucketEvent(
  bucket: AlgoActivity,
  ev: { event_type: string; details: Record<string, unknown> | null; created_at: string },
  notable: NotableSave[]
): void {
  bucket.evaluations++;
  if (ev.event_type === "signal_detected" || ev.event_type === "position_opened") {
    bucket.fires++;
    return;
  }
  const reason = String(ev.details?.reason ?? "");
  if (reason === "market_state_gate") bucket.gate_refusals++;
  else if (reason.startsWith("Entry conditions")) bucket.condition_misses++;
  else if (reason.startsWith("LLM decision:")) bucket.llm_holds++;
  else if (reason.startsWith("Most recent bar closed")) bucket.bar_staleness_refusals++;
  else if (reason.includes("drifted")) {
    bucket.drift_refusals++;
    const d = ev.details ?? {};
    notable.push({
      when: ev.created_at,
      algorithm: bucket.name,
      reason: "live_price_drift",
      confidence: typeof d.confidence === "number" ? (d.confidence as number) : null,
      would_have_entered_side:
        typeof d.would_have_entered_side === "string"
          ? (d.would_have_entered_side as string)
          : null,
      llm_reasoning: typeof d.llm_reasoning === "string" ? (d.llm_reasoning as string) : null,
    });
  } else {
    bucket.other_refusals++;
  }
}

async function aggregateAlgoEvents(
  supabase: Supa,
  algos: Array<{ id: string; name: string }>,
  since: string
): Promise<{ perAlgo: AlgoActivity[]; notable: NotableSave[] }> {
  const perAlgo: AlgoActivity[] = [];
  const notable: NotableSave[] = [];
  for (const a of algos) {
    const bucket: AlgoActivity = {
      algorithm_id: a.id,
      name: a.name,
      evaluations: 0,
      gate_refusals: 0,
      condition_misses: 0,
      drift_refusals: 0,
      bar_staleness_refusals: 0,
      llm_holds: 0,
      other_refusals: 0,
      fires: 0,
    };
    const { data: eventsRaw, error: eventsErr } = await supabase
      .from("activity_log")
      .select("event_type, details, created_at")
      .eq("algorithm_id", a.id)
      .gte("created_at", since)
      .in("event_type", ["signal_no_action", "signal_detected", "position_opened"])
      .limit(5000);
    if (eventsErr) throw new Error(`engine-activity events query failed (${a.name}): ${eventsErr.message}`);
    for (const e of eventsRaw ?? []) {
      bucketEvent(
        bucket,
        e as { event_type: string; details: Record<string, unknown> | null; created_at: string },
        notable
      );
    }
    perAlgo.push(bucket);
  }
  perAlgo.sort((a, b) => a.name.localeCompare(b.name));
  return { perAlgo, notable };
}

/**
 * Build the engine-activity payload. Caller passes a supabase client
 * (anon or service-role; the queries filter to active algorithms +
 * read-only tables so RLS applies cleanly when called from the UI).
 *
 * `days` is the window size; defaults to 7 (operator weekly review).
 */
export async function buildEngineActivity(supabase: Supa, days = 7): Promise<EngineActivity> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data: algosRaw, error: algosErr } = await supabase
    .from("algorithms")
    .select("id, name")
    .eq("status", "active");
  if (algosErr) throw new Error(`engine-activity algos query failed: ${algosErr.message}`);
  const algos = (algosRaw ?? []) as Array<{ id: string; name: string }>;

  const { data: decisionsRaw, error: decErr } = await supabase
    .from("llm_decisions")
    .select("decision, confidence, context, created_at")
    .eq("source", "live")
    .gte("created_at", since);
  if (decErr) throw new Error(`engine-activity decisions query failed: ${decErr.message}`);
  const decisions = summarizeDecisions((decisionsRaw ?? []) as DecisionRow[]);

  const { perAlgo, notable } = await aggregateAlgoEvents(supabase, algos, since);

  return {
    window_days: days,
    since,
    llm_decisions: decisions.total,
    llm_avg_confidence: decisions.avgConfidence,
    llm_by_decision: decisions.byDecision,
    llm_by_mtf: decisions.byMtf,
    per_algo: perAlgo,
    notable_saves: notable,
  };
}
