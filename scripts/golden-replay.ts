/**
 * make backtest — replay the golden slice and compare, or regenerate it.
 *
 *   pnpm exec tsx scripts/golden-replay.ts            # compare; exit 1 on any difference
 *   pnpm exec tsx scripts/golden-replay.ts --update   # rewrite tests/golden/xau-usd-h4-2026h1.golden.json
 */
import { existsSync, writeFileSync } from "node:fs";
import { comparable, GOLDEN_PATH, readGolden, replayGolden, RUNS } from "../tests/golden/replay";

function main(): number {
  const update = process.argv.includes("--update");
  const current = replayGolden();
  for (const runKey of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
    const run = current.runs[runKey];
    console.log(
      `${runKey}: ${String(run.trade_count)} trades in window (+${String(run.warmup_trade_count)} warm-up), total P&L ${run.total_pnl.toFixed(2)}`
    );
  }
  if (update) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`wrote ${GOLDEN_PATH}`);
    return 0;
  }
  if (!existsSync(GOLDEN_PATH)) {
    // A compare run never writes: a missing golden file is a failure, not a reason to create one.
    console.error(
      `golden: ${GOLDEN_PATH} is missing. Create it on purpose with \`make backtest-update\` and commit it with an explanation.`
    );
    return 1;
  }
  const golden = readGolden();
  const a = JSON.stringify(comparable(golden));
  const b = JSON.stringify(comparable(current));
  if (a === b) {
    console.log("golden: MATCH");
    return 0;
  }
  console.error("golden: DIFFERENT — the engine's trades on the pinned slice changed.");
  for (const runKey of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
    const g = golden.runs[runKey];
    const c = current.runs[runKey];
    const gKeys = new Set(g.trades.map((t) => `${t.algorithm}|${t.entry_date}`));
    const cKeys = new Set(c.trades.map((t) => `${t.algorithm}|${t.entry_date}`));
    const added = [...cKeys].filter((k) => !gKeys.has(k));
    const removed = [...gKeys].filter((k) => !cKeys.has(k));
    console.error(
      `  ${runKey}: golden ${String(g.trade_count)} trades / ${g.total_pnl.toFixed(2)}; now ${String(c.trade_count)} / ${c.total_pnl.toFixed(2)}`
    );
    if (added.length > 0) console.error(`    new entries: ${added.join(", ")}`);
    if (removed.length > 0) console.error(`    missing entries: ${removed.join(", ")}`);
    if (added.length === 0 && removed.length === 0) {
      console.error(
        "    same entries, different prices/P&L/reasons — run the vitest test for the per-field diff"
      );
    }
  }
  console.error(
    "If this change is intended: pnpm exec tsx scripts/golden-replay.ts --update, commit the golden file, explain in the PR."
  );
  return 1;
}

process.exit(main());
