/**
 * Variant selector — picks the "best for now" parameter variant from a
 * pre-registered grid based on a recent-window backtest. The retune
 * action layer of the learning loop (issue #220).
 *
 * Pre-registered selection rule (do NOT edit post-hoc per
 * feedback_audit_proposals_rigorously_before_presenting):
 *   - Compute mean R-multiple over the last LOOKBACK_DAYS for each
 *     variant.
 *   - Only variants with ≥ MIN_TRADES (3) in the lookback are eligible.
 *   - Pick the variant with highest mean R.
 *   - Tie-break order: (1) more trades wins, (2) current variant wins.
 *   - If no variant is eligible, KEEP CURRENT (no retune).
 *
 * Defended against curve-fit by being drift-triggered upstream (issue
 * #220): the selector only runs when the drift detector fires, not on
 * every weekly tick. Variant grid is pre-registered, never expanded
 * post-hoc.
 */

export interface VariantTrade {
  variantKey: string;
  exitDate: Date;
  r: number;
}

export interface VariantSelectorOptions {
  asOf: Date;
  /** Days back from asOf to consider for variant ranking. */
  lookbackDays?: number;
  /** Min trades per variant to be eligible. */
  minTrades?: number;
  /** Variant currently in use — used for tie-breaking + fallback when
   *  no variant is eligible. */
  current: string;
}

export const DEFAULT_LOOKBACK_DAYS = 30;
export const DEFAULT_MIN_TRADES = 3;

export interface VariantStats {
  variantKey: string;
  n: number;
  meanR: number;
  sumR: number;
  wr: number;
}

export interface SelectionVerdict {
  picked: string;
  reason: string;
  /** All eligible variants ranked by selection criterion. */
  ranked: VariantStats[];
  /** Variants present but below MIN_TRADES. */
  ineligible: VariantStats[];
}

function statsFor(trades: VariantTrade[]): Omit<VariantStats, "variantKey"> {
  const n = trades.length;
  if (n === 0) return { n: 0, meanR: 0, sumR: 0, wr: 0 };
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;
  return { n, meanR: sumR / n, sumR, wr: wins / n };
}

/** Select the variant whose recent-window backtest performs best. */
export function selectVariant(
  trades: VariantTrade[],
  opts: VariantSelectorOptions
): SelectionVerdict {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const minTrades = opts.minTrades ?? DEFAULT_MIN_TRADES;
  const cutoff = opts.asOf.getTime() - lookbackDays * 86_400_000;

  const grouped = new Map<string, VariantTrade[]>();
  for (const t of trades) {
    if (t.exitDate.getTime() < cutoff) continue;
    if (t.exitDate.getTime() >= opts.asOf.getTime()) continue;
    const arr = grouped.get(t.variantKey) ?? [];
    arr.push(t);
    grouped.set(t.variantKey, arr);
  }

  const eligible: VariantStats[] = [];
  const ineligible: VariantStats[] = [];
  for (const [key, vTrades] of grouped) {
    const s = statsFor(vTrades);
    const stat: VariantStats = { variantKey: key, ...s };
    if (s.n >= minTrades) eligible.push(stat);
    else ineligible.push(stat);
  }
  eligible.sort((a, b) => {
    // Primary: mean R descending
    if (b.meanR !== a.meanR) return b.meanR - a.meanR;
    // Tie-break 1: more trades wins
    if (b.n !== a.n) return b.n - a.n;
    // Tie-break 2: current variant wins
    if (a.variantKey === opts.current) return -1;
    if (b.variantKey === opts.current) return 1;
    return 0;
  });
  ineligible.sort((a, b) => b.n - a.n);

  if (eligible.length === 0) {
    return {
      picked: opts.current,
      reason: `no variant has ≥${minTrades} trades in last ${lookbackDays}d — kept current`,
      ranked: [],
      ineligible,
    };
  }
  const winner = eligible[0];
  return {
    picked: winner.variantKey,
    reason:
      winner.variantKey === opts.current
        ? `current variant '${winner.variantKey}' still leads (meanR=${winner.meanR.toFixed(2)}, n=${winner.n})`
        : `switched from '${opts.current}' to '${winner.variantKey}' (meanR=${winner.meanR.toFixed(2)}, n=${winner.n})`,
    ranked: eligible,
    ineligible,
  };
}
