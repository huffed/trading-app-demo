/**
 * Decay + recovery detector — the rule that flags cohort/algo
 * expectancy decay, extracted from `scripts/cohort-report.ts` so the
 * same logic can be shared between the weekly report AND the auto-loop
 * meta-backtest (issue #216).
 *
 * Pre-registered thresholds (do NOT edit post-hoc per
 * feedback_audit_proposals_rigorously_before_presenting):
 *
 *   PAUSE rule (matches cohort-report.ts:457):
 *     - 14d rolling mean R drops ≥ 0.5R vs the prior 14d, OR
 *     - 14d rolling WR drops ≥ 20 percentage points vs the prior 14d
 *     - Both halves require n ≥ 5 trades or the comparison is skipped.
 *
 *   RESUME rule (NEW, defined here, pre-registered for issue #216):
 *     - 14d rolling mean R ≥ 0.0 with n ≥ 3 trades in the window.
 *     - Lower n than the pause rule because we want to re-enter on
 *       early signal once the algo's expectancy has stopped bleeding.
 *
 * If empirical Level A meta-backtest shows these thresholds are too
 * loose / too tight as an action threshold (likely outcome —
 * report-thresholds tolerate more noise than action-thresholds), ship
 * a follow-on PR with a NEW pre-registered set rather than tweaking
 * these in-place. Curve-fitting the auto-loop is exactly what this
 * exercise is designed to avoid.
 */

export interface DecayTrade {
  date: Date;
  /** R-multiple. Positive = win, negative = loss. */
  r: number;
}

export interface DecayStats {
  n: number;
  meanR: number;
  /** Win-rate as a fraction in [0, 1]. */
  wr: number;
}

export const DEFAULT_HALF_WINDOW_DAYS = 14;
export const DEFAULT_DECAY_MIN_N = 5;
export const DEFAULT_MEAN_R_DROP = 0.5;
export const DEFAULT_WR_DROP_PCT = 20;
export const DEFAULT_RECOVERY_MIN_N = 3;
export const DEFAULT_RECOVERY_MEAN_R = 0.0;

export interface DecayCheckOptions {
  asOf: Date;
  halfWindowDays?: number;
  minN?: number;
  meanRDropThreshold?: number;
  wrDropPctThreshold?: number;
}

export interface DecayVerdict {
  flagged: boolean;
  reason?: string;
  recent: DecayStats | null;
  prior: DecayStats | null;
}

export interface RecoveryCheckOptions {
  asOf: Date;
  windowDays?: number;
  minN?: number;
  meanRRecoveryThreshold?: number;
}

export interface RecoveryVerdict {
  recovered: boolean;
  reason?: string;
  recent: DecayStats | null;
}

function statsFor(trades: DecayTrade[]): DecayStats {
  const n = trades.length;
  if (n === 0) return { n: 0, meanR: 0, wr: 0 };
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;
  return { n, meanR: sumR / n, wr: wins / n };
}

/** Decay verdict at `asOf`: compare the last `halfWindowDays` of trades
 *  against the `halfWindowDays` before that. Identical logic to
 *  `cohort-report.ts`'s inline decay block. */
export function detectDecay(
  trades: DecayTrade[],
  opts: DecayCheckOptions
): DecayVerdict {
  const halfDays = opts.halfWindowDays ?? DEFAULT_HALF_WINDOW_DAYS;
  const minN = opts.minN ?? DEFAULT_DECAY_MIN_N;
  const meanDropThr = opts.meanRDropThreshold ?? DEFAULT_MEAN_R_DROP;
  const wrDropThr = opts.wrDropPctThreshold ?? DEFAULT_WR_DROP_PCT;

  const asOfMs = opts.asOf.getTime();
  const recentStart = asOfMs - halfDays * 86_400_000;
  const priorStart = asOfMs - 2 * halfDays * 86_400_000;

  const recent = trades.filter(
    (t) => t.date.getTime() >= recentStart && t.date.getTime() < asOfMs
  );
  const prior = trades.filter(
    (t) =>
      t.date.getTime() >= priorStart && t.date.getTime() < recentStart
  );

  if (recent.length < minN || prior.length < minN) {
    return {
      flagged: false,
      reason: `insufficient n (recent=${recent.length}, prior=${prior.length}, need ${minN})`,
      recent: recent.length ? statsFor(recent) : null,
      prior: prior.length ? statsFor(prior) : null,
    };
  }

  const r = statsFor(recent);
  const p = statsFor(prior);
  const meanDrop = p.meanR - r.meanR;
  const wrDropPp = (p.wr - r.wr) * 100;

  if (meanDrop >= meanDropThr) {
    return {
      flagged: true,
      reason: `meanR ${p.meanR.toFixed(2)}→${r.meanR.toFixed(2)} (Δ=${meanDrop.toFixed(2)} ≥ ${meanDropThr}); n ${p.n}→${r.n}`,
      recent: r,
      prior: p,
    };
  }
  if (wrDropPp >= wrDropThr) {
    return {
      flagged: true,
      reason: `WR ${(p.wr * 100).toFixed(0)}%→${(r.wr * 100).toFixed(0)}% (Δ=${wrDropPp.toFixed(0)}pp ≥ ${wrDropThr}pp); n ${p.n}→${r.n}`,
      recent: r,
      prior: p,
    };
  }
  return { flagged: false, recent: r, prior: p };
}

/** Recovery verdict at `asOf`: the last `windowDays` of trades, mean R
 *  has recovered to ≥ threshold (default 0.0) with at least `minN`
 *  (default 3) trades. Used to re-enable a paused algo. */
export function detectRecovery(
  trades: DecayTrade[],
  opts: RecoveryCheckOptions
): RecoveryVerdict {
  const days = opts.windowDays ?? DEFAULT_HALF_WINDOW_DAYS;
  const minN = opts.minN ?? DEFAULT_RECOVERY_MIN_N;
  const recoveryR = opts.meanRRecoveryThreshold ?? DEFAULT_RECOVERY_MEAN_R;

  const asOfMs = opts.asOf.getTime();
  const recentStart = asOfMs - days * 86_400_000;
  const recent = trades.filter(
    (t) => t.date.getTime() >= recentStart && t.date.getTime() < asOfMs
  );

  if (recent.length < minN) {
    return {
      recovered: false,
      reason: `insufficient n (recent=${recent.length}, need ${minN})`,
      recent: recent.length ? statsFor(recent) : null,
    };
  }

  const r = statsFor(recent);
  if (r.meanR >= recoveryR) {
    return {
      recovered: true,
      reason: `recent meanR ${r.meanR.toFixed(2)} ≥ ${recoveryR} (n ${r.n})`,
      recent: r,
    };
  }
  return { recovered: false, recent: r };
}
