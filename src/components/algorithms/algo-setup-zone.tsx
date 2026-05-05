"use client";

/**
 * Collapsible setup zone for the algorithm detail page. Wraps rules
 * display, watchlist, and the portfolio backtest harness in a single
 * glass-bordered region. Default collapsed because operators rarely
 * touch configuration during daily review.
 *
 * Older orphans (DiscoveryCard, AiBacktestCard, BacktestRankingCard,
 * standalone BacktestResultsDisplay) were removed — Discovery was
 * stocks-era multi-ticker screening, AiBacktestCard read the legacy
 * `trades` table not paper_positions, RankingCard was degenerate for
 * single-ticker watchlists, and the standalone BacktestResultsDisplay
 * duplicated the in-line summary already shown by PortfolioBacktestCard.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { isSentimentCondition, type Algorithm } from "@/types/algorithm";
import { PortfolioBacktestCard } from "./portfolio-backtest-card";
import { RulesDisplay } from "./rules-display";
import { WatchlistCard } from "./watchlist-card";

interface AlgoSetupZoneProps {
  algo: Pick<
    Algorithm,
    "id" | "description" | "rules" | "asset_class" | "time_horizon"
  >;
}

function ExpandedPanel({ algo }: AlgoSetupZoneProps) {
  const hasSentiment = algo.rules.entry_conditions.some(isSentimentCondition);

  return (
    <div className="space-y-4 border-t border-glass-border p-4">
      {algo.description && (
        <Card>
          <CardContent className="p-4">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{algo.description}</div>
          </CardContent>
        </Card>
      )}
      <RulesDisplay rules={algo.rules} />
      <WatchlistCard
        algorithmId={algo.id}
        hasSentimentConditions={hasSentiment}
        assetClass={algo.asset_class}
      />
      <PortfolioBacktestCard algorithmId={algo.id} timeframe={algo.time_horizon} />
    </div>
  );
}

export function AlgoSetupZone(props: AlgoSetupZoneProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-glass-border bg-surface-low backdrop-blur-xl">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between p-4 text-left hover:bg-glass-highlight"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Setup &amp; configuration</span>
          <span className="text-xs text-muted-foreground">rules · watchlist · backtest</span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && <ExpandedPanel {...props} />}
    </div>
  );
}
