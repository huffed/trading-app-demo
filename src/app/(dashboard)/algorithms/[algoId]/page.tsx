"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlgoHeader,
  BacktestTab,
  DeleteAlgoDialog,
  OverviewTab,
  RerunPrompt,
} from "@/components/algorithms/algorithm-detail-parts";
import { AlgorithmEditView } from "@/components/algorithms/algorithm-edit-view";
import { DiscoveryCard } from "@/components/algorithms/discovery-card";
import { PaperTradingTab } from "@/components/algorithms/paper-trading-tab";
import { WatchlistCard } from "@/components/algorithms/watchlist-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAlgorithm,
  useDeleteAlgorithm,
  useRunAiBacktest,
  useRunHistoricalBacktest,
  useUpdateAlgorithm,
} from "@/hooks/use-algorithms";
import type { BacktestMetrics } from "@/lib/market-data/types";
import {
  isSentimentCondition,
  type Algorithm,
  type AlgorithmRules,
  type AlgorithmStatus,
} from "@/types/algorithm";

function ReadView({
  algo,
  backtestError,
  aiBacktestError,
  localBacktestResults,
  onRunAiBacktest,
  onRunBacktest,
  isAiPending,
  isBtPending,
}: {
  algo: Pick<
    Algorithm,
    | "id"
    | "name"
    | "description"
    | "rules"
    | "ai_analysis"
    | "backtest_results"
    | "status"
    | "last_scanned_at"
    | "asset_class"
    | "time_horizon"
  >;
  backtestError: string | null;
  aiBacktestError: string | null;
  localBacktestResults: BacktestMetrics | null;
  onRunAiBacktest: () => void;
  onRunBacktest: (symbol: string, period: string) => void;
  isAiPending: boolean;
  isBtPending: boolean;
}) {
  return (
    <Tabs defaultValue={0}>
      <TabsList variant="line">
        <TabsTrigger value={0}>Overview</TabsTrigger>
        <TabsTrigger value={1}>Watchlist</TabsTrigger>
        <TabsTrigger value={2}>Backtest</TabsTrigger>
        <TabsTrigger value={3}>Paper Trading</TabsTrigger>
      </TabsList>
      <OverviewTab algo={algo} />
      <TabsContent value={1} className="space-y-4 pt-2">
        <WatchlistCard
          algorithmId={algo.id}
          hasSentimentConditions={algo.rules.entry_conditions.some(isSentimentCondition)}
          assetClass={algo.asset_class}
        />
        <DiscoveryCard algorithmId={algo.id} />
      </TabsContent>
      <BacktestTab
        algo={algo}
        backtestError={backtestError}
        aiBacktestError={aiBacktestError}
        localBacktestResults={localBacktestResults}
        onRunAiBacktest={onRunAiBacktest}
        onRunBacktest={onRunBacktest}
        isAiPending={isAiPending}
        isBtPending={isBtPending}
      />
      <TabsContent value={3} className="space-y-4 pt-2">
        <PaperTradingTab
          algorithmId={algo.id}
          algorithmStatus={algo.status}
          lastScannedAt={algo.last_scanned_at}
        />
      </TabsContent>
    </Tabs>
  );
}

function useAlgoDetailState(algoId: string) {
  const router = useRouter();
  const { data: algo, isLoading } = useAlgorithm(algoId);
  const deleteMutation = useDeleteAlgorithm();
  const updateMutation = useUpdateAlgorithm();
  const backtestMutation = useRunAiBacktest();
  const historicalBacktest = useRunHistoricalBacktest();
  const [showDelete, setShowDelete] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [aiBacktestError, setAiBacktestError] = useState<string | null>(null);
  const [localBacktestResults, setLocalBacktestResults] = useState<BacktestMetrics | null>(null);
  const [showRerunPrompt, setShowRerunPrompt] = useState(false);

  const handleSave = (updates: {
    name: string;
    description: string;
    status: AlgorithmStatus;
    rules: AlgorithmRules;
  }) => {
    const rulesChanged = algo && JSON.stringify(updates.rules) !== JSON.stringify(algo.rules);
    updateMutation.mutate(
      { id: algoId, updates },
      {
        onSuccess: (r) => {
          if (r.success) {
            setIsEditing(false);
            if (rulesChanged) {
              setShowRerunPrompt(true);
            }
          }
        },
      }
    );
  };

  const handleHistoricalBacktest = (symbol: string, period: string) => {
    setBacktestError(null);
    setShowRerunPrompt(false);
    historicalBacktest.mutate(
      { id: algoId, symbol, period: period as "compact" | "full" },
      {
        onSuccess: (r) => {
          if (!r.success) {
            setBacktestError(r.error);
          } else {
            setLocalBacktestResults(r.data as BacktestMetrics);
          }
        },
        onError: () => setBacktestError("Backtest failed. Check symbol and try again."),
      }
    );
  };

  return {
    algo,
    isLoading,
    router,
    deleteMutation,
    updateMutation,
    backtestMutation,
    historicalBacktest,
    showDelete,
    setShowDelete,
    isEditing,
    setIsEditing,
    backtestError,
    aiBacktestError,
    setAiBacktestError,
    localBacktestResults,
    showRerunPrompt,
    setShowRerunPrompt,
    handleSave,
    handleHistoricalBacktest,
  };
}

export default function AlgorithmDetailPage() {
  const { algoId } = useParams<{ algoId: string }>();
  const s = useAlgoDetailState(algoId);

  if (s.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!s.algo) {
    return (
      <div className="mx-auto max-w-2xl text-center py-16">
        <p className="text-sm text-muted-foreground">Algorithm not found</p>
        <Button
          className="mt-4"
          variant="outline"
          render={<Link href="/algorithms" />}
          nativeButton={false}
        >
          Back to Algorithms
        </Button>
      </div>
    );
  }

  const algo = s.algo;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AlgoHeader
        name={algo.name}
        status={algo.status}
        isEditing={s.isEditing}
        onEdit={() => s.setIsEditing(true)}
        onDelete={() => s.setShowDelete(true)}
      />
      {s.showRerunPrompt && <RerunPrompt onDismiss={() => s.setShowRerunPrompt(false)} />}
      {s.isEditing ? (
        <AlgorithmEditView
          algorithm={algo}
          onSave={s.handleSave}
          onCancel={() => s.setIsEditing(false)}
          isSaving={s.updateMutation.isPending}
        />
      ) : (
        <ReadView
          algo={algo}
          backtestError={s.backtestError}
          aiBacktestError={s.aiBacktestError}
          localBacktestResults={s.localBacktestResults}
          onRunAiBacktest={() => {
            s.setAiBacktestError(null);
            s.backtestMutation.mutate(algo.id, {
              onSuccess: (r) => {
                if (!r.success) {
                  s.setAiBacktestError(r.error);
                }
              },
            });
          }}
          onRunBacktest={s.handleHistoricalBacktest}
          isAiPending={s.backtestMutation.isPending}
          isBtPending={s.historicalBacktest.isPending}
        />
      )}
      <DeleteAlgoDialog
        name={algo.name}
        open={s.showDelete}
        onOpenChange={s.setShowDelete}
        isPending={s.deleteMutation.isPending}
        onConfirm={() => {
          s.deleteMutation.mutate(algo.id, { onSuccess: () => s.router.push("/algorithms") });
        }}
      />
    </div>
  );
}
