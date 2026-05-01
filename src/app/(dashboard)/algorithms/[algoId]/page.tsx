"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlgoActivitySection } from "@/components/algorithms/algo-activity-section";
import { AlgoHistorySection } from "@/components/algorithms/algo-history-section";
import { AlgoLlmDecisionsSection } from "@/components/algorithms/algo-llm-decisions-section";
import { AlgoSetupSection } from "@/components/algorithms/algo-setup-section";
import { AlgoStatusSection } from "@/components/algorithms/algo-status-section";
import { AlgoTodaySection } from "@/components/algorithms/algo-today-section";
import {
  AlgoHeader,
  DeleteAlgoDialog,
  RerunPrompt,
} from "@/components/algorithms/algorithm-detail-parts";
import { AlgorithmEditView } from "@/components/algorithms/algorithm-edit-view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAlgorithm,
  useDeleteAlgorithm,
  useRunAiBacktest,
  useUpdateAlgorithm,
} from "@/hooks/use-algorithms";
import type {
  Algorithm,
  AlgorithmRules,
  AlgorithmStatus,
} from "@/types/algorithm";

function ReadView({
  algo,
  aiBacktestError,
  onRunAiBacktest,
  isAiPending,
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
    | "live_trading_enabled"
  >;
  aiBacktestError: string | null;
  onRunAiBacktest: () => void;
  isAiPending: boolean;
}) {
  return (
    <div className="space-y-4">
      <AlgoStatusSection
        algorithmId={algo.id}
        algorithmStatus={algo.status}
        liveTradingEnabled={algo.live_trading_enabled ?? false}
        lastScannedAt={algo.last_scanned_at}
      />
      <AlgoTodaySection algorithmId={algo.id} />
      <AlgoHistorySection algorithmId={algo.id} />
      {algo.rules?.llm_trader?.enabled && (
        <AlgoLlmDecisionsSection algorithmId={algo.id} />
      )}
      <AlgoSetupSection
        algo={algo}
        aiBacktestError={aiBacktestError}
        onRunAiBacktest={onRunAiBacktest}
        isAiPending={isAiPending}
      />
      <AlgoActivitySection algorithmId={algo.id} />
    </div>
  );
}

function useAlgoDetailState(algoId: string) {
  const router = useRouter();
  const { data: algo, isLoading } = useAlgorithm(algoId);
  const deleteMutation = useDeleteAlgorithm();
  const updateMutation = useUpdateAlgorithm();
  const backtestMutation = useRunAiBacktest();
  const [showDelete, setShowDelete] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [aiBacktestError, setAiBacktestError] = useState<string | null>(null);
  const [showRerunPrompt, setShowRerunPrompt] = useState(false);

  const handleSave = (updates: {
    name: string;
    description: string;
    status: AlgorithmStatus;
    rules: AlgorithmRules;
    live_trading_enabled: boolean;
    broker_connection_id: string | null;
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

  return {
    algo,
    isLoading,
    router,
    deleteMutation,
    updateMutation,
    backtestMutation,
    showDelete,
    setShowDelete,
    isEditing,
    setIsEditing,
    aiBacktestError,
    setAiBacktestError,
    showRerunPrompt,
    setShowRerunPrompt,
    handleSave,
  };
}

export default function AlgorithmDetailPage() {
  const { algoId } = useParams<{ algoId: string }>();
  const s = useAlgoDetailState(algoId);

  if (s.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
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
    <div className="mx-auto max-w-5xl space-y-4">
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
          aiBacktestError={s.aiBacktestError}
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
          isAiPending={s.backtestMutation.isPending}
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
