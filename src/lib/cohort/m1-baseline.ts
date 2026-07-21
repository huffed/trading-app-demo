/**
 * M1 / G.8 gate baseline — the fidelity-corrected backtest expectation the
 * live paper stream is measured against (MILESTONE M1 "First Proven
 * Stream": 30 portfolio trades with mean per-trade R within ±30%).
 *
 * GENERATED VALUES — do not hand-edit numbers. Source of truth:
 *   `MODE=algo-stats pnpm dlx tsx scripts/canonical/e2.22-layer-b-pinned.ts`
 * which writes `scripts/canonical/e2-results/g8-baseline.json`
 * (complete-fidelity harness — session-day daily, floating ML,
 * de-compounding, gap fills — on the sha-verified pinned H4 corpus
 * 2015→2026, deployed 5-algo portfolio @ 0.42% uniform risk).
 * Transcribed 2026-07-21 from artifact generated_at 2026-07-21T16:47:45Z.
 * Cross-checks vs preregistration.json G.8 entry: n=843, WR 35.6%,
 * ~0.48%/mo, worst floating ML 7.82% — all match.
 *
 * Mean R here is risk-normalized per trade (pnl / (equity_at_entry ×
 * risk%)), the same statistic the live side computes from price deltas
 * ((exit − entry) / (entry − initial_SL)) — both scale-free, so the
 * comparison is valid across capital sizes and uniform risk rescales
 * (evidence-clock rule E2.24.g.v).
 *
 * Regenerate + re-transcribe on ANY re-derivation that changes the
 * baseline (harness fix, geometry change, portfolio composition change —
 * composition changes also re-baseline the G.8 clock per the
 * evidence-clock rule).
 */

export interface M1AlgoBaseline {
  /** Harness label (matches e2.22-layer-b-pinned.ts member labels). */
  label: string;
  /** Exact `algorithms.name` of the deployed live row. */
  live_name: string;
  /** In-sample SOLO trade count on the pinned corpus. */
  n: number;
  wr_pct: number;
  /** SOLO mean per-trade R. Sibling gating slightly changes live
   *  composition, so per-algo tracking is indicative; the GATE is on the
   *  portfolio row. */
  mean_r: number;
}

export interface M1Baseline {
  /** Artifact provenance. */
  generated_at: string;
  source: string;
  /** Uniform per-trade risk the baseline was computed at. */
  risk_pct: number;
  /** Evidence-clock start: the 5-algo portfolio re-baseline (prereg
   *  registered_at). Only positions opened at/after this count. */
  clock_start: string;
  gate: { min_trades: number; tolerance_pct: number };
  portfolio: {
    n: number;
    wr_pct: number;
    /** THE gate baseline: sibling-aware portfolio mean per-trade R. */
    mean_r: number;
    monthly_pct: number;
    worst_ml_pct: number;
  };
  per_algo: M1AlgoBaseline[];
}

export const M1_BASELINE: M1Baseline = {
  generated_at: "2026-07-21T16:47:45.767Z",
  source:
    "e2.22-layer-b-pinned.ts MODE=algo-stats (complete-fidelity harness, pinned H4 2015→2026) — scripts/canonical/e2-results/g8-baseline.json",
  risk_pct: 0.42,
  clock_start: "2026-07-20T00:00:00Z",
  gate: { min_trades: 30, tolerance_pct: 30 },
  portfolio: {
    n: 843,
    wr_pct: 35.587188612099645,
    mean_r: 0.2551416481692455,
    monthly_pct: 0.48450892677954926,
    worst_ml_pct: 7.818341424845858,
  },
  per_algo: [
    {
      label: "ARB rr3_lb3",
      live_name: "Deploy: XAU/USD ARB+DailyBias 4h | r085 v1",
      n: 155,
      wr_pct: 33.5483870967742,
      mean_r: 0.24749663416348605,
    },
    {
      label: "Engulfing rr3_lb6",
      live_name: "Deploy: XAU/USD Engulfing+DailyBias 4h | r080 v1",
      n: 118,
      wr_pct: 33.89830508474576,
      mean_r: 0.2879308197072845,
    },
    {
      label: "ARB rr25_lb3",
      live_name: "Deploy: XAU/USD ARB25+DailyBias 4h | r080 v1",
      n: 170,
      wr_pct: 34.11764705882353,
      mean_r: 0.14133981185179317,
    },
    {
      label: "OutsideBar v2 rr3_lb3",
      live_name: "Deploy: XAU/USD OutsideBar+DailyBias 4h | rr3_lb3 r066 v2",
      n: 211,
      wr_pct: 31.753554502369667,
      mean_r: 0.18314735577809596,
    },
    {
      label: "Engulfing25 rr25_lb4",
      live_name: "Deploy: XAU/USD Engulfing25+DailyBias 4h | r042 v1",
      n: 198,
      wr_pct: 41.91919191919192,
      mean_r: 0.3667774317463865,
    },
  ],
};
