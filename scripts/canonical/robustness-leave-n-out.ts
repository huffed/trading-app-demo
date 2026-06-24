/**
 * F2.2 — Pattern leave-N-out robustness audit.
 *
 * Tests whether the v3 survivor's edge is pattern-specific or whether the
 * underlying (instrument, timeframe, direction) cell is genuinely
 * tradable across multiple pattern families. If only the survivor's
 * pattern produces a passer at its cell, the edge could be:
 *   - genuine pattern-specific signal, OR
 *   - search-noise that surfaced because we enumerated that pattern
 *
 * Leave-N-out can't distinguish those two by itself, but it surfaces the
 * RIGHT QUESTION: how many independent patterns produce per-candidate
 * passers at (XAU/USD, 4h, Long)? A 1-of-12 result is a different signal
 * than a 5-of-12 result.
 *
 * Method:
 *   1. Load all Layer A rows (Search:*) from DB
 *   2. Filter to survivor's cell: (ticker, timeframe, direction) match
 *   3. Per-pattern pass/fail using existing passesPerCandidate()
 *   4. Count non-survivor patterns that also pass
 *   5. Gate (pre-registered): ≥3 of 11 non-survivor patterns also pass
 *
 * Wall clock: ~1s (pure analysis on persisted JSONB; no new backtests).
 *
 * Persists scripts/canonical/robustness-leave-n-out-results.json with
 * the full per-pattern verdict + count for F2.5.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/robustness-leave-n-out.ts
 *
 * Env:
 *   SURVIVOR_TICKER     default "XAU/USD"
 *   SURVIVOR_TIMEFRAME  default "4h"
 *   SURVIVOR_DIRECTION  default "Long" (capitalised; matches name token)
 *   SURVIVOR_PATTERN    default "Engulfing"
 *   GATE_THRESHOLD      default 3 (out of 11 non-survivor patterns)
 *   OUTPUT_JSON         default scripts/canonical/robustness-leave-n-out-results.json
 *   PERSIST             default 1
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  evaluateAgainstCriteria,
  type PersistedBacktestResults,
  passesPerCandidate,
} from "../../src/lib/algo-search/criteria";
import type { Database } from "../../src/lib/supabase/database.types";

// .env.local loader
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

const SURVIVOR_TICKER = process.env.SURVIVOR_TICKER ?? "XAU/USD";
const SURVIVOR_TIMEFRAME = process.env.SURVIVOR_TIMEFRAME ?? "4h";
const SURVIVOR_DIRECTION = process.env.SURVIVOR_DIRECTION ?? "Long";
const SURVIVOR_PATTERN = process.env.SURVIVOR_PATTERN ?? "Engulfing";
const GATE_THRESHOLD = Math.max(1, Number(process.env.GATE_THRESHOLD ?? 3));
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/robustness-leave-n-out-results.json";
const PERSIST = process.env.PERSIST !== "0";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "robustness-leave-n-out requires NEXT_PUBLIC_SUPABASE_URL + " +
        "SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return { url, key };
}

/** Parse "Search: XAU/USD Engulfing-Long 4h" into structured tokens.
 *  Returns null when the name doesn't match the canonical Layer A format. */
function parseLayerAName(
  name: string,
): { ticker: string; pattern: string; direction: string; timeframe: string } | null {
  // Expected: "Search: <TICKER> <PATTERN>-<DIRECTION> <TF>"
  const prefixed = name.replace(/^Search:\s*/, "");
  if (prefixed === name) return null;
  // Capture TICKER (may contain /), then PATTERN-DIRECTION token, then TF.
  // Use a non-greedy ticker capture up to the first space before a
  // PATTERN-DIRECTION token.
  const match = prefixed.match(/^(\S+)\s+([A-Za-z][A-Za-z]*(?:-[A-Za-z]+)*)-(Long|Short)\s+(\d+[mh])$/);
  if (!match) return null;
  const [, ticker, pattern, direction, timeframe] = match;
  return { ticker, pattern, direction, timeframe };
}

interface PerPatternResult {
  pattern: string;
  is_survivor_pattern: boolean;
  algo_name: string | null;
  has_backtest: boolean;
  passes_per_candidate: boolean;
  criteria_summary: { passed: number; total: number } | null;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  console.log(`F2.2 pattern leave-N-out robustness audit`);
  console.log(`  survivor cell : ${SURVIVOR_TICKER} ${SURVIVOR_TIMEFRAME} ${SURVIVOR_DIRECTION}`);
  console.log(`  survivor pattern : ${SURVIVOR_PATTERN}`);
  console.log(`  gate threshold : ≥${GATE_THRESHOLD} non-survivor patterns also pass`);
  console.log("");

  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("name, backtest_results")
    .like("name", "Search:%");
  if (error) throw new Error(`Failed to fetch Layer A rows: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error("No Search:* rows in algorithms table — Layer A enumeration not persisted");
  }

  console.log(`Loaded ${rows.length} Layer A rows`);

  // Filter to survivor's cell.
  const cellRows = rows
    .map((r) => ({
      name: r.name,
      results: r.backtest_results as PersistedBacktestResults | null,
      parsed: parseLayerAName(r.name),
    }))
    .filter((r) => r.parsed !== null)
    .filter((r) => {
      const p = r.parsed!;
      return (
        p.ticker === SURVIVOR_TICKER &&
        p.timeframe === SURVIVOR_TIMEFRAME &&
        p.direction === SURVIVOR_DIRECTION
      );
    });

  console.log(`Filtered to survivor's cell : ${cellRows.length} patterns at ${SURVIVOR_TICKER} ${SURVIVOR_TIMEFRAME} ${SURVIVOR_DIRECTION}`);

  if (cellRows.length === 0) {
    throw new Error(
      `No Layer A rows at survivor's cell (${SURVIVOR_TICKER} ${SURVIVOR_TIMEFRAME} ${SURVIVOR_DIRECTION}). ` +
        `Check that Layer A sweep persisted Search:* rows for this cell.`,
    );
  }

  // Build per-pattern result.
  const perPattern: PerPatternResult[] = cellRows.map((r) => {
    const pattern = r.parsed!.pattern;
    const isSurvivorPattern = pattern === SURVIVOR_PATTERN;
    const hasBacktest = r.results !== null && r.results !== undefined;
    const passes = hasBacktest ? passesPerCandidate(r.results) : false;
    const criteria = hasBacktest ? evaluateAgainstCriteria(r.results) : null;
    return {
      pattern,
      is_survivor_pattern: isSurvivorPattern,
      algo_name: r.name,
      has_backtest: hasBacktest,
      passes_per_candidate: passes,
      criteria_summary: criteria
        ? { passed: criteria.filter((c) => c.passed).length, total: criteria.length }
        : null,
    };
  });

  const survivorEntry = perPattern.find((p) => p.is_survivor_pattern);
  if (!survivorEntry) {
    throw new Error(
      `No row at survivor's pattern (${SURVIVOR_PATTERN}) in survivor's cell. Check spec.`,
    );
  }
  if (!survivorEntry.passes_per_candidate) {
    console.warn(
      `WARNING: survivor pattern (${SURVIVOR_PATTERN}) does NOT pass per-candidate criteria at its own cell. ` +
        `Layer A results may be stale.`,
    );
  }

  const nonSurvivorPasses = perPattern.filter(
    (p) => !p.is_survivor_pattern && p.passes_per_candidate,
  );
  const nonSurvivorTotal = perPattern.filter((p) => !p.is_survivor_pattern).length;
  const passCount = nonSurvivorPasses.length;

  const verdict: "PASS" | "FAIL" = passCount >= GATE_THRESHOLD ? "PASS" : "FAIL";

  console.log("");
  console.log(`F2.2 LEAVE-N-OUT VERDICT: ${verdict}`);
  console.log(`  non-survivor patterns at cell : ${nonSurvivorTotal}`);
  console.log(`  non-survivor passers           : ${passCount}`);
  console.log(`  gate threshold                : ≥${GATE_THRESHOLD}`);
  console.log("");
  console.log(`Per-pattern breakdown at ${SURVIVOR_TICKER} ${SURVIVOR_TIMEFRAME} ${SURVIVOR_DIRECTION}:`);
  for (const p of perPattern) {
    const marker = p.is_survivor_pattern ? "★" : p.passes_per_candidate ? "✓" : "✗";
    const stats = p.criteria_summary
      ? `(${p.criteria_summary.passed}/${p.criteria_summary.total} criteria)`
      : "(no backtest)";
    console.log(`  ${marker} ${p.pattern.padEnd(20)} ${stats}`);
  }

  const output = {
    sub_gate: "F2.2 leave-n-out" as const,
    verdict,
    pass_count: passCount,
    gate_threshold: GATE_THRESHOLD,
    survivor_cell: {
      ticker: SURVIVOR_TICKER,
      timeframe: SURVIVOR_TIMEFRAME,
      direction: SURVIVOR_DIRECTION,
      pattern: SURVIVOR_PATTERN,
    },
    non_survivor_total: nonSurvivorTotal,
    non_survivor_passers: nonSurvivorPasses.map((p) => p.pattern),
    per_pattern: perPattern,
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  } else {
    console.log("");
    console.log("(PERSIST=0 — verdict only, no file written)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
