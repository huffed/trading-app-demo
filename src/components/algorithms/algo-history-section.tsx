"use client";

import { AlgoEquityCurveCard } from "./algo-equity-curve-card";
import { AlgoSection } from "./algo-section";
import { StrategyStatsTab } from "./strategy-stats-tab";

/**
 * History section — performance over time. Default collapsed; opened
 * for weekly / monthly review rather than daily checks.
 *
 *   - Equity curve
 *   - Strategy stats (win rate, avg trade, holding time, etc.)
 *
 * Closed-positions all-time list intentionally lives in the Today
 * section's ClosedPositionsCard for now — the operator's "what
 * just happened" review uses recent closes. A dedicated "all closed"
 * paginated view belongs here when the closed-position count grows
 * past what fits in the Today section.
 */
export function AlgoHistorySection({ algorithmId }: { algorithmId: string }) {
  return (
    <AlgoSection
      storageKey={`algo:${algorithmId}:section:history`}
      title="History & performance"
    >
      <AlgoEquityCurveCard algorithmId={algorithmId} />
      <StrategyStatsTab algorithmId={algorithmId} />
    </AlgoSection>
  );
}
