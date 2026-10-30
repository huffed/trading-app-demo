/**
 * Golden-file test — see tests/golden/replay.ts. A failing diff here means the
 * engine now produces different trades on the pinned 2026 H1 slice. Either
 * that was the intent (regenerate with `pnpm exec tsx scripts/golden-replay.ts
 * --update`, commit the new file, and say why in the PR) or it is a regression.
 */
import { describe, expect, it } from "vitest";
import { comparable, readGolden, replayGolden, RUNS } from "./replay";

describe("golden trade list — five deployed algorithms, XAU/USD 4h, 2026-01-01 → 2026-07-09", () => {
  const golden = readGolden();
  const current = replayGolden();

  it("inputs are the same pinned corpora and rules fixture", () => {
    expect(current.inputs).toEqual(golden.inputs);
  });

  for (const runKey of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
    it(`${runKey}: same trades, same prices, same P&L, same exit reasons`, () => {
      expect(current.runs[runKey]).toEqual(golden.runs[runKey]);
    });
  }

  it("the whole file matches (everything but the timestamp)", () => {
    expect(comparable(current)).toEqual(comparable(golden));
  });

  it("the window produced trades in both runs and the floor run has no more trades than the paper run", () => {
    expect(golden.runs["100k_paper_capital"].trade_count).toBeGreaterThan(0);
    expect(golden.runs["10k_pool_floor"].trade_count).toBeLessThanOrEqual(
      golden.runs["100k_paper_capital"].trade_count
    );
  });
});
