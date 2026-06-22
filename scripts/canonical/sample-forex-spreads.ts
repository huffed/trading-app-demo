/**
 * Stage 4.2.a — Forex spread sampler.
 *
 * Empirically calibrate `TYPICAL_SPREAD_PIPS` (currently literature default)
 * against MetaApi-observed broker spreads, broken down by liquidity regime.
 * Closes the "ATR-only proxy" hand-wave in the spread-gate.
 *
 * **Operator runs this manually** during a target session window (it's a
 * long-running poll, not a cron-able workflow). Multiple short runs over
 * a week build the corpus.
 *
 * Design (per Stage 4.2.a agent spec 2026-06-20):
 *   - 60s base interval + ±10s uniform jitter (decorrelates from any
 *     60s-aligned broker quote rotation; ~2% of MetaApi rate budget)
 *   - Per (pair × session-window) buckets; n≥400 ships, n≥100 directional
 *   - Stale-quote detection: skip if (bid, ask, time) matches prior poll
 *     OR if quote.time > 30s older than wall clock at fetch
 *   - Two outputs:
 *       1. raw samples → `scripts/canonical/data/forex-spread-samples-<YYYY-MM-DD>.json`
 *          (append per-day so runs accumulate)
 *       2. rolling calibration → `scripts/canonical/data/forex-spread-calibration.json`
 *          (validate-algo consumes this for Stage 4.2.b per-pair friction)
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/sample-forex-spreads.ts
 *     # defaults: PAIRS="EUR/USD,USD/JPY,GBP/USD" WINDOW="overlap" DURATION_MIN=180
 *   PAIRS="EUR/USD" WINDOW="london_mid" DURATION_MIN=240 pnpm dlx tsx scripts/canonical/sample-forex-spreads.ts
 *
 * Env:
 *   PAIRS         CSV of app-symbol pairs (e.g. "EUR/USD,USD/JPY"). Default: 3 majors.
 *   WINDOW        Session-window label (asia_quiet | london_open | london_mid | overlap | ny_afternoon | ny_close).
 *                 Used only for tagging the per-sample records; doesn't gate when sampling runs.
 *   DURATION_MIN  Sampler runtime in minutes. Default 180 (3 hours).
 *   POLL_SEC      Base poll interval seconds. Default 60. Don't go below 30 (rate limit).
 *   CONN_LABEL    Override which broker_connection label to use. Default: first metaapi connection.
 *
 * Required env (validator-style inline loader at top):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { createClient } from "@supabase/supabase-js";
import { fetchCurrentPrice, type MetaApiRegion } from "@/lib/brokers/metaapi";
import { FOREX_PAIRS } from "@/lib/constants/markets";

// Inline .env.local loader — mirrors validate-algo.ts pattern so the operator
// can run this script directly without `dotenv -- pnpm dlx tsx ...` ceremony.
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
    // No .env.local — that's fine if env is already set by the shell.
  }
}

const PAIRS_CSV = process.env.PAIRS ?? "EUR/USD,USD/JPY,GBP/USD";
const SESSION_WINDOWS = ["asia_quiet", "london_open", "london_mid", "overlap", "ny_afternoon", "ny_close"] as const;
type SessionWindow = (typeof SESSION_WINDOWS)[number];
const WINDOW_RAW = (process.env.WINDOW ?? "overlap") as SessionWindow;
const DURATION_MIN = Math.max(5, Number(process.env.DURATION_MIN ?? 180));
const POLL_SEC = Math.max(30, Number(process.env.POLL_SEC ?? 60));
const POLL_JITTER_SEC = 10;
const STALE_QUOTE_AGE_SEC = 30;
const CONN_LABEL_OVERRIDE = process.env.CONN_LABEL ?? null;

if (!SESSION_WINDOWS.includes(WINDOW_RAW)) {
  console.error(`Invalid WINDOW="${WINDOW_RAW}". Must be one of: ${SESSION_WINDOWS.join(", ")}`);
  process.exit(1);
}
const WINDOW: SessionWindow = WINDOW_RAW;

interface SampleRecord {
  ts: string; // ISO timestamp of the fetch
  pair: string; // app-symbol (e.g. "EUR/USD")
  window: SessionWindow;
  bid: number;
  ask: number;
  spread_pips: number;
  quote_time: string; // broker-reported quote timestamp
  quote_age_sec: number; // wall-clock - quote_time
}

interface CalibrationStats {
  n: number;
  median_pips: number;
  p25_pips: number;
  p75_pips: number;
  p90_pips: number;
  p99_pips: number;
  max_pips: number;
}

interface CalibrationForPair {
  overall: CalibrationStats;
  by_window: Partial<Record<SessionWindow, CalibrationStats>>;
}

interface CalibrationFile {
  last_updated: string;
  pairs: Record<string, CalibrationForPair>;
  /** Total runs that contributed to this calibration so the operator
   *  can see corpus depth at a glance. */
  contributing_runs: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function summariseStats(spreads: number[]): CalibrationStats {
  const sorted = [...spreads].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median_pips: Number(quantile(sorted, 0.5).toFixed(4)),
    p25_pips: Number(quantile(sorted, 0.25).toFixed(4)),
    p75_pips: Number(quantile(sorted, 0.75).toFixed(4)),
    p90_pips: Number(quantile(sorted, 0.9).toFixed(4)),
    p99_pips: Number(quantile(sorted, 0.99).toFixed(4)),
    max_pips: Number((sorted[sorted.length - 1] ?? 0).toFixed(4)),
  };
}

function pipSizeFor(pair: string): number | null {
  const meta = FOREX_PAIRS.find((m) => m.symbol.toUpperCase() === pair.toUpperCase());
  return meta?.pipSize ?? null;
}

async function loadConn(): Promise<{
  apiToken: string;
  accountId: string;
  region: MetaApiRegion;
  label: string;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "sample-forex-spreads: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required in .env.local."
    );
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const res = await supabase
    .from("broker_connections")
    .select("id, label, provider, api_token, account_id, region")
    .eq("provider", "metaapi");
  if (res.error) {
    throw new Error(
      `loadConn: broker_connections query failed — message="${res.error.message}" code="${res.error.code ?? "n/a"}"`
    );
  }
  const conns = (res.data ?? []) as Array<{
    label: string;
    api_token: string;
    account_id: string;
    region: string | null;
  }>;
  if (conns.length === 0) {
    throw new Error("loadConn: no metaapi broker_connections found.");
  }
  const picked = CONN_LABEL_OVERRIDE
    ? conns.find((c) => c.label === CONN_LABEL_OVERRIDE)
    : conns[0];
  if (!picked) {
    throw new Error(
      `loadConn: no metaapi connection with label="${CONN_LABEL_OVERRIDE}". Available: ${conns.map((c) => c.label).join(", ")}`
    );
  }
  return {
    apiToken: picked.api_token,
    accountId: picked.account_id,
    region: (picked.region as MetaApiRegion) ?? "london",
    label: picked.label,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function ensureDir(filepath: string): void {
  const dir = dirname(filepath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeRawSamples(records: SampleRecord[]): string {
  const dateKey = new Date().toISOString().slice(0, 10);
  const path = resolvePath(`scripts/canonical/data/forex-spread-samples-${dateKey}.json`);
  ensureDir(path);
  let existing: SampleRecord[] = [];
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      existing = JSON.parse(raw) as SampleRecord[];
    } catch {
      // Corrupt file from a previous crashed run — back it up + start fresh.
      const backup = `${path}.${Date.now()}.bak`;
      writeFileSync(backup, readFileSync(path, "utf8"));
      console.warn(`Existing samples file unreadable; backed up to ${backup} + starting fresh.`);
    }
  }
  const merged = existing.concat(records);
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return path;
}

function updateCalibration(allRecords: SampleRecord[]): string {
  const path = resolvePath("scripts/canonical/data/forex-spread-calibration.json");
  ensureDir(path);
  // Load existing calibration to preserve contributing_runs counter.
  let existing: CalibrationFile = {
    last_updated: new Date().toISOString(),
    pairs: {},
    contributing_runs: 0,
  };
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      existing = JSON.parse(raw) as CalibrationFile;
    } catch {
      console.warn(`Existing calibration file unreadable — overwriting.`);
    }
  }

  // Rebuild from the union of (existing pairs) + (this run's records).
  // We can't truly "rebuild from union" without loading every per-day
  // samples file — that's a separate `rebuild-spread-calibration.ts`
  // future utility. For now: this run's records update THIS pair's stats
  // for THIS window only. Operator runs multiple windows over a week to
  // build the full calibration.
  const pairs = { ...existing.pairs };
  const byPair = new Map<string, SampleRecord[]>();
  for (const r of allRecords) {
    const list = byPair.get(r.pair) ?? [];
    list.push(r);
    byPair.set(r.pair, list);
  }
  for (const [pair, records] of byPair) {
    const prev = pairs[pair] ?? { overall: { n: 0, median_pips: 0, p25_pips: 0, p75_pips: 0, p90_pips: 0, p99_pips: 0, max_pips: 0 }, by_window: {} };
    const newSpreads = records.map((r) => r.spread_pips);
    pairs[pair] = {
      // Overall is THIS run's snapshot, not lifetime — see future
      // rebuild-spread-calibration.ts for a lifetime summariser.
      overall: summariseStats(newSpreads),
      by_window: {
        ...prev.by_window,
        // Update only the window this run sampled.
        [WINDOW]: summariseStats(newSpreads),
      },
    };
  }
  const out: CalibrationFile = {
    last_updated: new Date().toISOString(),
    pairs,
    contributing_runs: existing.contributing_runs + 1,
  };
  writeFileSync(path, JSON.stringify(out, null, 2));
  return path;
}

async function main(): Promise<void> {
  console.log(`\n===== sample-forex-spreads @ ${new Date().toISOString().slice(0, 16)} =====`);
  const pairs = PAIRS_CSV.split(",").map((p) => p.trim()).filter(Boolean);
  console.log(`Pairs:           ${pairs.join(", ")}`);
  console.log(`Window tag:      ${WINDOW}`);
  console.log(`Duration:        ${DURATION_MIN} min`);
  console.log(`Poll interval:   ${POLL_SEC}s base ± ${POLL_JITTER_SEC}s jitter`);
  console.log(`Stale threshold: ${STALE_QUOTE_AGE_SEC}s`);

  // Pre-validate pairs (catch typos before the long run).
  for (const p of pairs) {
    const pip = pipSizeFor(p);
    if (pip == null) {
      throw new Error(
        `sample-forex-spreads: ${p} not in FOREX_PAIRS catalog. Add to src/lib/constants/markets.ts or fix the typo.`
      );
    }
  }

  const conn = await loadConn();
  console.log(`Broker:          metaapi/${conn.region}/${conn.label}\n`);

  const endTimeMs = Date.now() + DURATION_MIN * 60 * 1000;
  const records: SampleRecord[] = [];
  // For stale detection: last (bid, ask, quote_time) per pair.
  const lastQuote = new Map<string, { bid: number; ask: number; time: string }>();
  let stale = 0;
  let errors = 0;
  let polls = 0;
  // Stage 4.2.a follow-up (2026-06-20 agent finding): per-pair consecutive
  // failure tracking + bail. Previously the script would happily burn the
  // operator's entire DURATION_MIN window polling a dead pair (e.g. broker
  // closed market, wrong symbol mapping, expired API token for one symbol).
  // Reset to 0 on success; skip a pair for one iteration when >= MAX_CONSECUTIVE_FAILS.
  const MAX_CONSECUTIVE_FAILS = 5;
  const consecutiveFails = new Map<string, number>();
  const droppedPairs = new Set<string>();

  while (Date.now() < endTimeMs) {
    polls++;
    const pollStartedAt = Date.now();
    for (const pair of pairs) {
      // Skip pairs that have been dropped due to too many consecutive failures.
      if (droppedPairs.has(pair)) continue;
      try {
        const quote = await fetchCurrentPrice(conn.apiToken, conn.accountId, conn.region, pair);
        const wallNowMs = Date.now();
        // MetaApi `time` is documented but sometimes omitted (broker-side
        // quirk). Skip samples without a timestamp — without it we can't
        // do stale-detection or dedupe correctly.
        if (!quote.time) {
          stale++;
          continue;
        }
        const quoteAgeSec = (wallNowMs - new Date(quote.time).getTime()) / 1000;
        const dup = lastQuote.get(pair);
        const isStaleAge = quoteAgeSec > STALE_QUOTE_AGE_SEC;
        const isDuplicate =
          dup !== undefined && dup.bid === quote.bid && dup.ask === quote.ask && dup.time === quote.time;
        if (isStaleAge || isDuplicate) {
          stale++;
          // A stale/dup quote is NOT a fetch failure — reset the fail counter.
          consecutiveFails.set(pair, 0);
          continue;
        }
        lastQuote.set(pair, { bid: quote.bid, ask: quote.ask, time: quote.time });
        consecutiveFails.set(pair, 0);
        const pip = pipSizeFor(pair) as number; // pre-validated above
        const spread_pips = (quote.ask - quote.bid) / pip;
        records.push({
          ts: new Date(wallNowMs).toISOString(),
          pair,
          window: WINDOW,
          bid: quote.bid,
          ask: quote.ask,
          spread_pips: Number(spread_pips.toFixed(4)),
          quote_time: quote.time,
          quote_age_sec: Number(quoteAgeSec.toFixed(2)),
        });
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        const failCount = (consecutiveFails.get(pair) ?? 0) + 1;
        consecutiveFails.set(pair, failCount);
        console.warn(`[${new Date().toISOString().slice(11, 19)}] ${pair} fetch failed (${failCount}/${MAX_CONSECUTIVE_FAILS}): ${msg}`);
        // Stage 4.2.a follow-up: bail on this pair after MAX_CONSECUTIVE_FAILS
        // — keep sampling the other pairs but stop wasting MetaApi quota on
        // a pair that's clearly dead (closed market, bad symbol, token revoked).
        if (failCount >= MAX_CONSECUTIVE_FAILS) {
          droppedPairs.add(pair);
          console.warn(`[${new Date().toISOString().slice(11, 19)}] ${pair} DROPPED for the rest of this run after ${MAX_CONSECUTIVE_FAILS} consecutive failures. Other pairs continue.`);
        }
      }
    }
    // Early-exit safety: if ALL pairs have been dropped, no point continuing.
    if (droppedPairs.size === pairs.length) {
      console.warn(`All ${pairs.length} pairs dropped after consecutive failures. Aborting run early.`);
      break;
    }
    // Per-poll progress every 5 polls (~5 min at default).
    if (polls % 5 === 0) {
      const elapsedMin = Math.floor((Date.now() - (endTimeMs - DURATION_MIN * 60 * 1000)) / 60_000);
      const remainingMin = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 60_000));
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] poll ${polls} | samples=${records.length} | stale=${stale} | err=${errors} | elapsed=${elapsedMin}m | remaining=${remainingMin}m`
      );
    }
    // Sleep with jitter. End-cap on the last loop avoids oversleeping past end.
    const jitter = (Math.random() * 2 - 1) * POLL_JITTER_SEC; // ±jitter
    const targetMs = POLL_SEC * 1000 + jitter * 1000;
    const elapsed = Date.now() - pollStartedAt;
    const sleepMs = Math.max(0, targetMs - elapsed);
    if (sleepMs > 0) await sleep(sleepMs);
  }

  if (records.length === 0) {
    throw new Error(
      `sample-forex-spreads: 0 valid samples collected (${stale} stale, ${errors} errors). ` +
      `Likely causes: (a) market closed, (b) wrong CONN_LABEL, (c) MetaApi connection inactive. ` +
      `Run during an active session (London or NY) on a metaapi connection that mirrors a funded/demo account.`
    );
  }

  // Summary table
  const byPair = new Map<string, number[]>();
  for (const r of records) {
    const arr = byPair.get(r.pair) ?? [];
    arr.push(r.spread_pips);
    byPair.set(r.pair, arr);
  }
  console.log(`\n===== Summary (${WINDOW}, ${records.length} samples, ${stale} stale, ${errors} errors) =====`);
  console.log("┌────────────┬──────┬─────────┬─────────┬─────────┬─────────┬─────────┐");
  console.log("│ Pair       │   n  │ median  │   p25   │   p75   │   p90   │   max   │");
  console.log("├────────────┼──────┼─────────┼─────────┼─────────┼─────────┼─────────┤");
  for (const [pair, spreads] of byPair) {
    const s = summariseStats(spreads);
    console.log(
      `│ ${pair.padEnd(10)} │ ${s.n.toString().padStart(4)} │ ${s.median_pips.toFixed(2).padStart(7)} │ ${s.p25_pips.toFixed(2).padStart(7)} │ ${s.p75_pips.toFixed(2).padStart(7)} │ ${s.p90_pips.toFixed(2).padStart(7)} │ ${s.max_pips.toFixed(2).padStart(7)} │`
    );
  }
  console.log("└────────────┴──────┴─────────┴─────────┴─────────┴─────────┴─────────┘");

  const samplesPath = writeRawSamples(records);
  const calibPath = updateCalibration(records);
  console.log(`\nRaw samples:     ${samplesPath}`);
  console.log(`Calibration:     ${calibPath}`);
  console.log(`\nNext: run again for other windows (asia_quiet/london_open/london_mid/ny_afternoon/ny_close)`);
  console.log(`      to build full per-pair × per-window corpus. n≥400 per cell ships per Stage 4.2.a.`);
}

void main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
