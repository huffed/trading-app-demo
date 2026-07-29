/**
 * Locked constants + feasibility asserts for the 2026-10
 * Gold-Maximization + Forex round (algo-search-2026-10.spec.md,
 * IMMUTABLE 2026-07-29). The round driver imports THIS module — never
 * re-types the numbers — so spec/driver drift is impossible.
 *
 * The asserts encode the two self-defeating-test lessons:
 *  - E2.25.g: a bootstrap p-floor above α/N makes the strict tier
 *    unpassable-by-construction. The driver must abort, not run.
 *  - Spec §2: the enumerated N is part of the pre-registration; a
 *    drifted enumerator silently changes the Bonferroni denominator.
 */

export const SPEC_2026_10 = {
  /** Enumerated Layer-A cells: 4 instruments × axes per spec §2. */
  N_EXPECTED: 1_696,
  /** Block-bootstrap iterations — sized so the p-floor sits below α/N. */
  BOOTSTRAP_ITERATIONS: 20_000,
  FAMILY_ALPHA: 0.05,
  /** Operator-locked 2026-07-29 (`feedback_wr_floor_35`). */
  WR_FLOOR_PCT: 35,
  BLENDED_WR_FLOOR_PCT: 35,
  /** Layer-B time-relative lookback horizon, hours. */
  SL_LOOKBACK_HOURS: [12, 24, 48],
} as const;

/** Smallest achievable bootstrap p-value under the add-half convention. */
export function bootstrapPFloor(iterations: number): number {
  return 0.5 / (iterations + 1);
}

/**
 * Throws unless the round is statistically runnable as pre-registered:
 * exact cell count AND p-floor strictly below the per-test α. Call at
 * driver startup, before any backtest.
 */
export function assertSpecFeasible(
  enumeratedCells: number,
  iterations: number = SPEC_2026_10.BOOTSTRAP_ITERATIONS
): void {
  if (enumeratedCells !== SPEC_2026_10.N_EXPECTED) {
    throw new Error(
      `2026-10 spec drift: enumerator produced ${enumeratedCells} cells, spec pre-registered ${SPEC_2026_10.N_EXPECTED}. ` +
        `The Bonferroni denominator is part of the pre-registration — reconcile the enumerator or write a new dated spec.`
    );
  }
  const alphaPerTest = SPEC_2026_10.FAMILY_ALPHA / enumeratedCells;
  const floor = bootstrapPFloor(iterations);
  if (floor >= alphaPerTest) {
    throw new Error(
      `2026-10 spec infeasible: bootstrap p-floor ${floor.toExponential(3)} (B=${iterations}) >= α/N ${alphaPerTest.toExponential(3)} — ` +
        `the strict tier would be unpassable-by-construction (E2.25.g class). Raise BOOTSTRAP_ITERATIONS.`
    );
  }
}
