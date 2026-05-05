"use client";

/**
 * Collapsible setup zone for the algorithm detail page. Wraps the
 * existing setup sub-cards (rules, watchlist, discovery, backtest
 * harness, etc.) in a single glass-bordered region with a
 * show/hide toggle. Default collapsed because operators rarely
 * touch configuration during daily review.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { isSentimentCondition, type Algorithm } from "@/types/algorithm";
import { AiBacktestCard } from "./ai-backtest-card";
import { BacktestRankingCard } from "./backtest-ranking-card";
import { BacktestResultsDisplay } from "./backtest-results-display";
import { DiscoveryCard } from "./discovery-card";
import { PortfolioBacktestCard } from "./portfolio-backtest-card";
import { RulesDisplay } from "./rules-display";
import { WatchlistCard } from "./watchlist-card";

interface AlgoSetupZoneProps {
  algo: Pick<
    Algorithm,
    | "id"
    | "description"
    | "rules"
    | "ai_analysis"
    | "backtest_results"
    | "asset_class"
    | "time_horizon"
  >;
  aiBacktestError: string | null;
  onRunAiBacktest: () => void;
  isAiPending: boolean;
}

function ExpandedPanel({
  algo,
  aiBacktestError,
  onRunAiBacktest,
  isAiPending,
}: AlgoSetupZoneProps) {
  const { data: watchlistItems = [] } = useWatchlist(algo.id);
  const watchlistTickers = watchlistItems.map((w) => ({
    ticker: w.ticker,
    name: w.name,
    backtestMetrics: w.backtest_metrics as BacktestMetrics | null,
  }));
  const backtestResults = algo.backtest_results as BacktestMetrics | null;
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
      <DiscoveryCard algorithmId={algo.id} />
      <AiBacktestCard
        analysis={algo.ai_analysis}
        error={aiBacktestError}
        onRunBacktest={onRunAiBacktest}
        isPending={isAiPending}
      />
      <PortfolioBacktestCard algorithmId={algo.id} timeframe={algo.time_horizon} />
      <BacktestRankingCard algorithmId={algo.id} tickers={watchlistTickers} />
      {backtestResults && <BacktestResultsDisplay results={backtestResults} />}
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
