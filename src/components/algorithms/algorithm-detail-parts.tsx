"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Pencil, Trash2, X } from "lucide-react";
import { AiBacktestCard } from "@/components/algorithms/ai-backtest-card";
import { BacktestRankingCard } from "@/components/algorithms/backtest-ranking-card";
import { BacktestResultsDisplay } from "@/components/algorithms/backtest-results-display";
import { PortfolioBacktestCard } from "@/components/algorithms/portfolio-backtest-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TabsContent } from "@/components/ui/tabs";
import { useWatchlist } from "@/hooks/use-watchlist";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/constants/algorithm";
import type { BacktestMetrics } from "@/lib/market-data/types";
import type { Algorithm } from "@/types/algorithm";
import { RulesDisplay } from "./rules-display";

export function AlgoHeader({
  name,
  status,
  isEditing,
  onEdit,
  onDelete,
}: {
  name: string;
  status: string;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon-sm"
        render={<Link href="/algorithms" />}
        nativeButton={false}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      </div>
      <Badge variant={STATUS_COLORS[status] ?? "secondary"}>
        {STATUS_LABELS[status] ?? status}
      </Badge>
      {!isEditing && (
        <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit algorithm">
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onDelete}>
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

export function DeleteAlgoDialog({
  name,
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Delete Algorithm</DialogTitle>
          <DialogDescription>Delete &ldquo;{name}&rdquo;? This cannot be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={isPending} onClick={onConfirm}>
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OverviewTab({ algo }: { algo: Pick<Algorithm, "description" | "rules"> }) {
  return (
    <TabsContent value={0} className="space-y-4 pt-2">
      {algo.description && (
        <Card>
          <CardContent className="p-4">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{algo.description}</div>
          </CardContent>
        </Card>
      )}
      <RulesDisplay rules={algo.rules} />
    </TabsContent>
  );
}

export function BacktestTab({
  algo,
  aiBacktestError,
  onRunAiBacktest,
  isAiPending,
}: {
  algo: Pick<
    Algorithm,
    "id" | "ai_analysis" | "backtest_results" | "asset_class" | "time_horizon"
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
  const [resultsVisible, setResultsVisible] = useState(true);
  const backtestResults = algo.backtest_results as BacktestMetrics | null;

  return (
    <TabsContent value={2} className="space-y-4 pt-2">
      <AiBacktestCard
        analysis={algo.ai_analysis}
        error={aiBacktestError}
        onRunBacktest={onRunAiBacktest}
        isPending={isAiPending}
      />
      <PortfolioBacktestCard algorithmId={algo.id} timeframe={algo.time_horizon} />
      <BacktestRankingCard algorithmId={algo.id} tickers={watchlistTickers} />
      {backtestResults && resultsVisible && (
        <div className="relative">
          <Button
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2 z-10"
            onClick={() => setResultsVisible(false)}
          >
            <X className="h-3 w-3" />
          </Button>
          <BacktestResultsDisplay results={backtestResults} />
        </div>
      )}
    </TabsContent>
  );
}

export function RerunPrompt({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
      <span className="text-sm">Rules updated — re-run backtest?</span>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
