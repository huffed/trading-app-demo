"use client";

import { useOpenPositions } from "@/hooks/use-paper-trading";
import { AlgoSection } from "./algo-section";
import { NearMissFeed } from "./near-miss-feed";
import { ClosedPositionsCard, OpenPositionsCard } from "./position-cards";

/**
 * Today section — primary daily-review surface. What's live, what
 * just closed, what got considered.
 *
 *   1. Open positions (expandable detail cards)
 *   2. Closed today (last 24h sub-section)
 *   3. Considered (near-miss feed)
 */
export function AlgoTodaySection({ algorithmId }: { algorithmId: string }) {
  const { data: openPositions } = useOpenPositions(algorithmId);
  const openCount = openPositions?.length ?? 0;
  return (
    <AlgoSection
      storageKey={`algo:${algorithmId}:section:today`}
      defaultExpanded
      title="Today"
      summary={openCount > 0 ? `${openCount} open` : "no open positions"}
    >
      <OpenPositionsCard algorithmId={algorithmId} />
      <ClosedPositionsCard algorithmId={algorithmId} />
      <NearMissFeed algorithmId={algorithmId} />
    </AlgoSection>
  );
}
