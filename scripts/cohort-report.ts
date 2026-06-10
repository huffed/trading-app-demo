/**
 * Cohort report — the learning loop's REVIEW layer ("notice diminishing
 * returns", fundamental #3). $0 to run: reads existing llm_decisions +
 * paper_positions rows, no LLM calls.
 *
 * What it does:
 *  1. Pulls completed LLM-trader entries (llm_decisions rows with a
 *     backfilled trade_outcome) and joins per-trade cohort tags from
 *     paper_positions.entry_reason (regime / entry_zone /
 *     position_in_range_pct / entry_hour_utc — attribution live since
 *     2026-05-18; older trades report as "untagged").
 *  2. Aggregates expectancy per cohort dimension: regime, prompt
 *     version, side, confidence bucket, session bucket, exit reason.
 *  3. DECAY FLAGS: compares the last DAYS-day window against the DAYS
 *     before it per cohort (n ≥ MIN_N in both halves) and flags mean-R
 *     drops ≥ 0.5R or WR drops ≥ 20pp.
 *  4. SHADOW-GATE CANDIDATES: cohorts with n ≥ 8 and mean R ≤ −0.3 —
 *     these become log-only engine gates first (scoped per
 *     algo + prompt_version per the gate-scoping lessons), and only
 *     flip to enforcing after weeks of shadow evidence.
 *
 * Honesty rule: with small n the report SAYS "insufficient n" rather
 * than printing noise as signal. Cohort gates were reverted once
 * (#136/#137) for being calibrated on a single window — this report is
 * the cadence that prevents that class of mistake, not a license to
 * repeat it.
 *
 * Usage:
 *   pnpm dlx tsx scripts/cohort-report.ts
 *   DAYS=14      half-window length for decay comparison (default 14)
 *   SOURCE=live  llm_decisions source: live | walk_forward | all (default live)
 *   MIN_N=5      min trades per half-window for a decay comparison
 *
 * Cadence: weekly (or after any config change ships). Output JSON is
 * written next to the script (gitignored) for later diffing.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Self-load .env.local (same pattern as sibling scripts)
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

const DAYS = Number(process.env.DAYS ?? 14);
const SOURCE = process.env.SOURCE ?? "live";
const MIN_N = Number(process.env.MIN_N ?? 5);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// Fail loudly — a review tool must never render an error as "no data"
// (live-state.ts printed a false all-clear against a paused DB once).
function check<T extends { error: { message: string } | null }>(label: string, res: T): T {
  if (res.error) {
    console.error(`✗ Query failed [${label}]: ${res.error.message} — aborting.`);
    process.exit(1);
  }
  return res;
}

interface TradeOutcome {
  side?: string;
  exit_date?: string;
  exit_reason?: string;
  r_multiple?: number;
  realized_pnl?: number;
}

interface CohortTrade {
  date: Date;
  regime: string;
  promptVersion: string;
  side: string;
  confBucket: string;
  sessionBucket: string;
  zone: string;
  exitReason: string;
  r: number;
}

function sessionBucket(utcHour: number): string {
  if (utcHour < 7) return "asia(0-7)";
  if (utcHour < 13) return "london(7-13)";
  if (utcHour < 21) return "ny(13-21)";
  return "late(21-24)";
}

function confBucket(c: number | null): string {
  if (c == null) return "n/a";
  if (c < 70) return "<70";
  if (c < 75) return "70-74";
  return "75+";
}

async function main(): Promise<void> {
  console.log(`\n===== Cohort report @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`source=${SOURCE} · decay halves=${DAYS}d · MIN_N=${MIN_N}\n`);

  let q = supabase
    .from("llm_decisions")
    .select(
      "created_at, bar_date, regime, prompt_version, decision, confidence, paper_position_id, trade_outcome, source"
    )
    .in("decision", ["enter_long", "enter_short"])
    .not("trade_outcome", "is", null)
    .order("created_at", { ascending: true });
  if (SOURCE !== "all") q = q.eq("source", SOURCE);
  const { data: decisions } = check("llm_decisions", await q);
  const rows = decisions ?? [];

  // Join cohort tags from paper_positions.entry_reason (present on
  // entries opened after the 2026-05-18 attribution commit).
  const posIds = rows.map((r) => r.paper_position_id).filter(Boolean) as string[];
  const tagsById = new Map<string, Record<string, unknown>>();
  if (posIds.length > 0) {
    const { data: positions } = check(
      "paper_positions tags",
      await supabase.from("paper_positions").select("id, entry_reason").in("id", posIds)
    );
    for (const p of positions ?? []) {
      tagsById.set(p.id as string, (p.entry_reason ?? {}) as Record<string, unknown>);
    }
  }

  const trades: CohortTrade[] = [];
  for (const r of rows) {
    const outcome = (r.trade_outcome ?? {}) as TradeOutcome;
    if (typeof outcome.r_multiple !== "number") continue;
    const tags = r.paper_position_id ? (tagsById.get(r.paper_position_id) ?? {}) : {};
    const barDate = new Date((r.bar_date as string) ?? (r.created_at as string));
    trades.push({
      date: new Date(r.created_at as string),
      regime: (r.regime as string) ?? "n/a",
      promptVersion: (r.prompt_version as string) ?? "n/a",
      side: r.decision === "enter_long" ? "long" : "short",
      confBucket: confBucket(r.confidence as number | null),
      sessionBucket: sessionBucket(barDate.getUTCHours()),
      zone: typeof tags.entry_zone === "string" ? tags.entry_zone : "untagged",
      exitReason: outcome.exit_reason ?? "n/a",
      r: outcome.r_multiple,
    });
  }

  console.log(
    `${trades.length} completed entries with outcomes (${rows.length - trades.length} skipped without r_multiple) · ` +
      `${trades.filter((t) => t.zone !== "untagged").length} carry entry-zone tags\n`
  );
  if (trades.length === 0) {
    console.log("No data — nothing to report yet.");
    return;
  }

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

  interface Agg {
    n: number;
    wins: number;
    sumR: number;
  }
  const aggregate = (ts: CohortTrade[]): Agg => ({
    n: ts.length,
    wins: ts.filter((t) => t.r > 0).length,
    sumR: ts.reduce((s, t) => s + t.r, 0),
  });
  const fmt = (a: Agg): string =>
    `${pad(a.n.toString(), 5)}${pad(a.n ? `${((a.wins / a.n) * 100).toFixed(0)}%` : "-", 7)}${pad(
      a.n ? (a.sumR / a.n).toFixed(2) : "-",
      8
    )}${a.sumR.toFixed(1)}`;

  const DIMENSIONS: { label: string; key: (t: CohortTrade) => string }[] = [
    { label: "regime", key: (t) => t.regime },
    { label: "prompt_version", key: (t) => t.promptVersion },
    { label: "side", key: (t) => t.side },
    { label: "confidence", key: (t) => t.confBucket },
    { label: "session", key: (t) => t.sessionBucket },
    { label: "entry_zone", key: (t) => t.zone },
    { label: "exit_reason", key: (t) => t.exitReason },
  ];

  const byKey = (ts: CohortTrade[], key: (t: CohortTrade) => string): Map<string, CohortTrade[]> => {
    const m = new Map<string, CohortTrade[]>();
    for (const t of ts) {
      const k = key(t);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  };

  const report: Record<string, unknown> = {};

  console.log("--- All-time cohort expectancy ---");
  for (const dim of DIMENSIONS) {
    console.log(`\n${dim.label}:`);
    console.log(`  ${pad("value", 16)}${pad("n", 5)}${pad("WR", 7)}${pad("meanR", 8)}sumR`);
    const dimReport: Record<string, Agg> = {};
    for (const [value, ts] of [...byKey(trades, dim.key)].sort((a, b) => b[1].length - a[1].length)) {
      const a = aggregate(ts);
      dimReport[value] = a;
      console.log(`  ${pad(value, 16)}${fmt(a)}`);
    }
    report[dim.label] = dimReport;
  }

  // Decay comparison: last DAYS vs the DAYS before it.
  const now = Date.now();
  const recentStart = now - DAYS * 86400_000;
  const priorStart = now - 2 * DAYS * 86400_000;
  const recent = trades.filter((t) => t.date.getTime() >= recentStart);
  const prior = trades.filter(
    (t) => t.date.getTime() >= priorStart && t.date.getTime() < recentStart
  );

  console.log(`\n--- Decay flags (last ${DAYS}d vs prior ${DAYS}d, n≥${MIN_N} both halves) ---`);
  const decayFlags: string[] = [];
  for (const dim of DIMENSIONS) {
    const recentMap = byKey(recent, dim.key);
    const priorMap = byKey(prior, dim.key);
    for (const [value, rts] of recentMap) {
      const pts = priorMap.get(value) ?? [];
      if (rts.length < MIN_N || pts.length < MIN_N) continue;
      const ra = aggregate(rts);
      const pa = aggregate(pts);
      const meanDrop = pa.sumR / pa.n - ra.sumR / ra.n;
      const wrDrop = (pa.wins / pa.n - ra.wins / ra.n) * 100;
      if (meanDrop >= 0.5 || wrDrop >= 20) {
        const flag = `${dim.label}=${value}: meanR ${(pa.sumR / pa.n).toFixed(2)}→${(ra.sumR / ra.n).toFixed(2)}, WR ${((pa.wins / pa.n) * 100).toFixed(0)}%→${((ra.wins / ra.n) * 100).toFixed(0)}% (n ${pa.n}→${ra.n})`;
        decayFlags.push(flag);
        console.log(`  ⚠ ${flag}`);
      }
    }
  }
  if (decayFlags.length === 0) {
    console.log(
      recent.length < MIN_N || prior.length < MIN_N
        ? `  insufficient n for any comparison (recent=${recent.length}, prior=${prior.length}) — expected while live-paper data accumulates`
        : "  none"
    );
  }

  // Shadow-gate candidates.
  console.log(`\n--- Shadow-gate candidates (all-time n≥8, meanR ≤ −0.3) ---`);
  const candidates: string[] = [];
  for (const dim of DIMENSIONS) {
    if (dim.label === "exit_reason") continue; // outcome, not an entry cohort
    for (const [value, ts] of byKey(trades, dim.key)) {
      const a = aggregate(ts);
      if (a.n >= 8 && a.sumR / a.n <= -0.3) {
        const c = `${dim.label}=${value} (n=${a.n}, meanR ${(a.sumR / a.n).toFixed(2)}) → propose LOG-ONLY gate scoped per algo+prompt_version; enforce only after shadow evidence`;
        candidates.push(c);
        console.log(`  → ${c}`);
      }
    }
  }
  if (candidates.length === 0) console.log("  none at current n — keep accumulating");

  const outPath = `scripts/cohort-report-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      { generated_at: new Date().toISOString(), source: SOURCE, days: DAYS, min_n: MIN_N,
        trades: trades.length, dimensions: report, decay_flags: decayFlags, shadow_gate_candidates: candidates },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error("cohort-report failed:", err);
  process.exit(1);
});
