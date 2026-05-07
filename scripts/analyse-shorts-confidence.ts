/**
 * Match each short trade in the 4-window 15m WF to its entry decision
 * (by bar_date), bucket the entry confidence, and report WR + P&L per
 * confidence band. Tests whether a confidence-floor gate on shorts
 * would have filtered out the losers.
 *
 * The replay-shorts-asymmetric-sl.ts experiment falsified the SL-
 * widening hypothesis: wider SL didn't save a single losing short
 * because the original SL was rarely the actual exit. Losses come
 * from LLM `exit` decisions on counter-momentum.
 *
 * If confidence is informative — i.e. winning shorts cluster at higher
 * confidence than losing shorts — then a `confidence ≥ N` gate on
 * shorts could improve WR without re-prompting.
 *
 * If confidence is uninformative (per the existing
 * feedback_v3_confidence_uninformative memo on v3 prompt — 97% of
 * entries clustered at 70-75%), this analysis will show wins and
 * losses overlapping in the same confidence band, and the gate is
 * dead-on-arrival.
 *
 * Either way the answer is useful: if there's a clear edge above
 * confidence X we ship the gate; if not, we know to look elsewhere
 * (asymmetric RR, prompt-level short triggers, or just disabling
 * shorts).
 *
 * Inputs:
 *   - scripts/llm-trader-trades-anthropic-15m-30d-v5_15m-{A|B|C|D}-*.jsonl
 *   - scripts/llm-trader-decisions-anthropic-15m-30d-v5_15m-{A|B|C|D}-*.jsonl
 *
 * Output: confidence-bucket table per window + aggregate, plus a
 * sample of winning vs losing short reasonings to eyeball any
 * narrative pattern.
 *
 * Usage: pnpm dlx tsx scripts/analyse-shorts-confidence.ts
 */
import { readFileSync, readdirSync } from "fs";

interface Trade {
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  exit_reason: string;
  hold_bars: number;
  r_multiple: number;
  entry_regime?: string;
}

interface Decision {
  bar_date: string;
  bar_close?: number;
  regime: string;
  decision: string;
  confidence: number;
  reasoning: string;
  had_position?: string;
}

const RISK_PER_TRADE_USD = 1000;

function loadJSONL<T>(path: string): T[] {
  const out: T[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

function findWindowSuffix(file: string): string | null {
  const m = file.match(/-(?:trades|decisions)-anthropic-15m-30d-v5_15m-(.+?\.jsonl)$/);
  return m ? m[1] : null;
}

interface ShortRow {
  window: string;
  trade: Trade;
  conf: number;
  reasoning: string;
}

function bucketLabel(conf: number): string {
  if (conf < 65) return "<65";
  if (conf < 70) return "65-69";
  if (conf < 73) return "70-72";
  if (conf < 76) return "73-75";
  if (conf < 80) return "76-79";
  return "80+";
}

interface BucketStats {
  count: number;
  wins: number;
  pnl: number;
  rSum: number;
}

async function main(): Promise<void> {
  const tradeFiles = readdirSync("scripts").filter((f) =>
    /^llm-trader-trades-anthropic-15m-30d-v5_15m-[A-D]-/.test(f)
  );
  const decisionFiles = readdirSync("scripts").filter((f) =>
    /^llm-trader-decisions-anthropic-15m-30d-v5_15m-[A-D]-/.test(f)
  );
  tradeFiles.sort();
  decisionFiles.sort();

  // Pair trade files to decision files by window suffix.
  const decisionByWindow = new Map<string, string>();
  for (const f of decisionFiles) {
    const suf = findWindowSuffix(f);
    if (suf) decisionByWindow.set(suf, f);
  }

  const allShorts: ShortRow[] = [];

  for (const tradeFile of tradeFiles) {
    const suf = findWindowSuffix(tradeFile);
    if (!suf) continue;
    const decisionFile = decisionByWindow.get(suf);
    if (!decisionFile) {
      console.error(`No decision file for ${tradeFile}`);
      continue;
    }
    const labelMatch = tradeFile.match(/-([A-D])-/);
    const label = labelMatch ? labelMatch[1] : "?";

    const trades = loadJSONL<Trade>(`scripts/${tradeFile}`);
    const decisions = loadJSONL<Decision>(`scripts/${decisionFile}`);

    // Index decisions by bar_date for O(1) match.
    const decByDate = new Map<string, Decision>();
    for (const d of decisions) decByDate.set(d.bar_date, d);

    const shorts = trades.filter((t) => t.side === "short");
    for (const t of shorts) {
      // The decision for a short entry is the one whose bar_date
      // matches the trade's entry_date AND whose decision === "enter_short".
      // The trade's entry_date is the close of the trigger bar.
      const dec = decByDate.get(t.entry_date);
      if (!dec) {
        console.warn(
          `No decision for short at ${t.entry_date} window ${label} — skipping`
        );
        continue;
      }
      if (dec.decision !== "enter_short") {
        console.warn(
          `Decision at ${t.entry_date} is ${dec.decision} not enter_short (window ${label}) — skipping`
        );
        continue;
      }
      allShorts.push({
        window: label,
        trade: t,
        conf: dec.confidence,
        reasoning: dec.reasoning,
      });
    }
  }

  console.log(`Matched ${allShorts.length} shorts to entry decisions.`);
  console.log("");

  // ---- Distribution table ----
  console.log("===== Confidence distribution: shorts (all 4 windows) =====");
  console.log("");
  console.log("Bucket | Count | Wins | WR    | Mean R | Sum $   | Cum % of total");
  console.log("-------+-------+------+-------+--------+---------+--------------");

  const bucketOrder = ["<65", "65-69", "70-72", "73-75", "76-79", "80+"];
  const buckets = new Map<string, BucketStats>();
  for (const b of bucketOrder)
    buckets.set(b, { count: 0, wins: 0, pnl: 0, rSum: 0 });

  for (const s of allShorts) {
    const b = buckets.get(bucketLabel(s.conf))!;
    b.count++;
    if (s.trade.r_multiple > 0) b.wins++;
    b.pnl += s.trade.realized_pnl;
    b.rSum += s.trade.r_multiple;
  }

  let cumCount = 0;
  for (const label of bucketOrder) {
    const b = buckets.get(label)!;
    if (b.count === 0) continue;
    const wr = (b.wins / b.count) * 100;
    const meanR = b.rSum / b.count;
    cumCount += b.count;
    const cumPct = (cumCount / allShorts.length) * 100;
    console.log(
      `${label.padEnd(6)} |  ${b.count.toString().padStart(3)}  | ${b.wins.toString().padStart(3)}  | ${wr.toFixed(0).padStart(3)}%  | ${meanR >= 0 ? "+" : ""}${meanR.toFixed(2)}  | ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(0).padStart(5)} | ${cumPct.toFixed(0)}%`
    );
  }
  console.log("");

  // ---- "What if we gated on confidence ≥ X" ----
  console.log("===== Confidence-floor gate simulation =====");
  console.log("");
  console.log(
    "If we'd refused short entries below confidence X, this is what would have remained:"
  );
  console.log("");
  console.log("Floor  | Kept | Wins | WR    | Mean R | Sum $   | vs no-gate");
  console.log("-------+------+------+-------+--------+---------+----------");
  const totalPnl = allShorts.reduce((s, x) => s + x.trade.realized_pnl, 0);
  const totalWins = allShorts.filter((x) => x.trade.r_multiple > 0).length;
  const totalCount = allShorts.length;
  const floors = [60, 65, 70, 72, 73, 75, 76, 78, 80];
  for (const floor of floors) {
    const kept = allShorts.filter((x) => x.conf >= floor);
    if (kept.length === 0) {
      console.log(`≥ ${floor.toString().padStart(2)}    |   0  |   -  |   -   |    -   |     -   | filters everything`);
      continue;
    }
    const wins = kept.filter((x) => x.trade.r_multiple > 0).length;
    const pnl = kept.reduce((s, x) => s + x.trade.realized_pnl, 0);
    const rSum = kept.reduce((s, x) => s + x.trade.r_multiple, 0);
    const meanR = rSum / kept.length;
    const wr = (wins / kept.length) * 100;
    const dPnl = pnl - totalPnl;
    const dWins = wins - totalWins;
    console.log(
      `≥ ${floor.toString().padStart(2)}    |  ${kept.length.toString().padStart(2)}  | ${wins.toString().padStart(3)}  | ${wr.toFixed(0).padStart(3)}%  | ${meanR >= 0 ? "+" : ""}${meanR.toFixed(2)}  | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0).padStart(5)} | Δ ${dPnl >= 0 ? "+" : ""}$${dPnl.toFixed(0)} / ${dWins >= 0 ? "+" : ""}${dWins} wins / dropped ${totalCount - kept.length}`
    );
  }
  console.log("");

  // ---- Wins vs losses confidence comparison ----
  const wins = allShorts.filter((s) => s.trade.r_multiple > 0);
  const losses = allShorts.filter((s) => s.trade.r_multiple <= 0);
  const meanWin = wins.reduce((s, x) => s + x.conf, 0) / Math.max(wins.length, 1);
  const meanLoss = losses.reduce((s, x) => s + x.conf, 0) / Math.max(losses.length, 1);
  const minWin = wins.length > 0 ? Math.min(...wins.map((x) => x.conf)) : 0;
  const maxWin = wins.length > 0 ? Math.max(...wins.map((x) => x.conf)) : 0;
  const minLoss = losses.length > 0 ? Math.min(...losses.map((x) => x.conf)) : 0;
  const maxLoss = losses.length > 0 ? Math.max(...losses.map((x) => x.conf)) : 0;

  console.log("===== Wins vs losses on confidence =====");
  console.log("");
  console.log(`Wins   (n=${wins.length}):   conf min=${minWin}, max=${maxWin}, mean=${meanWin.toFixed(1)}`);
  console.log(`Losses (n=${losses.length}):  conf min=${minLoss}, max=${maxLoss}, mean=${meanLoss.toFixed(1)}`);
  const sep = meanWin - meanLoss;
  console.log(
    `Separation: ${sep >= 0 ? "+" : ""}${sep.toFixed(1)} pts (winners ${sep >= 0 ? "higher" : "lower"} on average)`
  );
  console.log("");

  // ---- Sample reasonings ----
  console.log("===== Sample reasonings =====");
  console.log("");
  console.log("--- Winning shorts (top 3 by R) ---");
  const sortedWins = [...wins].sort((a, b) => b.trade.r_multiple - a.trade.r_multiple);
  for (const s of sortedWins.slice(0, 3)) {
    console.log(
      `[${s.window}] ${s.trade.entry_date.slice(0, 16)} conf ${s.conf} → ${s.trade.r_multiple.toFixed(2)}R / $${s.trade.realized_pnl.toFixed(0)}`
    );
    console.log(`   ${s.reasoning.slice(0, 220)}${s.reasoning.length > 220 ? "..." : ""}`);
    console.log("");
  }
  console.log("--- Losing shorts (top 3 by |R|) ---");
  const sortedLosses = [...losses].sort((a, b) => a.trade.r_multiple - b.trade.r_multiple);
  for (const s of sortedLosses.slice(0, 3)) {
    console.log(
      `[${s.window}] ${s.trade.entry_date.slice(0, 16)} conf ${s.conf} → ${s.trade.r_multiple.toFixed(2)}R / $${s.trade.realized_pnl.toFixed(0)}`
    );
    console.log(`   ${s.reasoning.slice(0, 220)}${s.reasoning.length > 220 ? "..." : ""}`);
    console.log("");
  }

  // ---- Quick reference: total P&L without shorts at all ----
  console.log("===== Reference: longs vs shorts in the WF =====");
  console.log("");
  // Reload all trades to get longs P&L too.
  let longsPnl = 0,
    longsCount = 0,
    longsWins = 0;
  let shortsPnl = 0,
    shortsCount = 0,
    shortsWins = 0;
  for (const tradeFile of tradeFiles) {
    const trades = loadJSONL<Trade>(`scripts/${tradeFile}`);
    for (const t of trades) {
      if (t.side === "long") {
        longsPnl += t.realized_pnl;
        longsCount++;
        if (t.r_multiple > 0) longsWins++;
      } else {
        shortsPnl += t.realized_pnl;
        shortsCount++;
        if (t.r_multiple > 0) shortsWins++;
      }
    }
  }
  console.log(`Longs:  ${longsCount} trades, ${longsWins} wins (${((longsWins / longsCount) * 100).toFixed(0)}% WR), $${longsPnl.toFixed(0)}`);
  console.log(`Shorts: ${shortsCount} trades, ${shortsWins} wins (${((shortsWins / shortsCount) * 100).toFixed(0)}% WR), $${shortsPnl.toFixed(0)}`);
  console.log(`Total:  ${longsCount + shortsCount} trades, $${(longsPnl + shortsPnl).toFixed(0)}`);
  console.log("");
  console.log(`If shorts disabled entirely: $${longsPnl.toFixed(0)} (longs only)`);
  console.log(`If shorts kept as-is:        $${(longsPnl + shortsPnl).toFixed(0)} (current)`);
  void RISK_PER_TRADE_USD;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
