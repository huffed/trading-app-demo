"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { isSentimentCondition, type Algorithm } from "@/types/algorithm";
import { AiBacktestCard } from "./ai-backtest-card";
import { AlgoSection } from "./algo-section";
import { BacktestRankingCard } from "./backtest-ranking-card";
import { BacktestResultsDisplay } from "./backtest-results-display";
import { DiscoveryCard } from "./discovery-card";
import { PortfolioBacktestCard } from "./portfolio-backtest-card";
import { RulesDisplay } from "./rules-display";
import { WatchlistCard } from "./watchlist-card";

function BacktestResultsToggle({ results }: { results: BacktestMetrics }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div className="relative">
      <Button
        size="icon-xs"
        variant="ghost"
        className="absolute right-2 top-2 z-10"
        onClick={() => setVisible(false)}
      >
        <X className="h-3 w-3" />
      </Button>
      <BacktestResultsDisplay results={results} />
    </div>
  );
}

/**
 * Setup section — rules, watchlist, backtest. Default collapsed
 * because configuration is rare day-to-day. Combines what used to
 * be three separate top-level tabs (Overview / Watchlist / Backtest).
 */
export function AlgoSetupSection({
  algo,
  aiBacktestError,
  onRunAiBacktest,
  isAiPending,
}: {
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
}) {
  const { data: watchlistItems = [] } = useWatchlist(algo.id);
  const watchlistTickers = watchlistItems.map((w) => ({
    ticker: w.ticker,
    name: w.name,
    backtestMetrics: w.backtest_metrics as BacktestMetrics | null,
  }));
  const backtestResults = algo.backtest_results as BacktestMetrics | null;
  const hasSentiment = algo.rules.entry_conditions.some(isSentimentCondition);

  return (
    <AlgoSection storageKey={`algo:${algo.id}:section:setup`} title="Setup">
      {algo.description && (
        <Card>
          <CardContent className="p-4">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {algo.description}
            </div>
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
      {backtestResults && <BacktestResultsToggle results={backtestResults} />}
    </AlgoSection>
  );
}
