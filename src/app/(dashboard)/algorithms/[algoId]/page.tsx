"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlgoEquityHero } from "@/components/algorithms/algo-equity-hero";
import { AlgoInspectorRail } from "@/components/algorithms/algo-inspector-rail";
import { AlgoKpiStrip } from "@/components/algorithms/algo-kpi-strip";
import { AlgoLlmDecisionsSection } from "@/components/algorithms/algo-llm-decisions-section";
import { AlgoSetupZone } from "@/components/algorithms/algo-setup-zone";
import {
  AlgoHeader,
  DeleteAlgoDialog,
  RerunPrompt,
} from "@/components/algorithms/algorithm-detail-parts";
import { AlgorithmEditView } from "@/components/algorithms/algorithm-edit-view";
import { ClosedPositionsCard, OpenPositionsCard } from "@/components/algorithms/position-cards";
import { ContentShell } from "@/components/layout/content-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAlgorithm,
  useDeleteAlgorithm,
  useRunAiBacktest,
  useUpdateAlgorithm,
} from "@/hooks/use-algorithms";
import type { BacktestMetrics } from "@/lib/market-data/types";
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
  algo: Algorithm;
  aiBacktestError: string | null;
  onRunAiBacktest: () => void;
  isAiPending: boolean;
}) {
  return (
    <>
      <AlgoKpiStrip
        algorithmId={algo.id}
        backtestResults={(algo.backtest_results as BacktestMetrics | null) ?? null}
        lastScannedAt={algo.last_scanned_at}
      />
      <div className="mt-6 space-y-4">
        <AlgoEquityHero algorithmId={algo.id} />
        <OpenPositionsCard algorithmId={algo.id} />
        <ClosedPositionsCard algorithmId={algo.id} />
      </div>
      {algo.rules?.llm_trader?.enabled && (
        <div className="mt-4">
          <AlgoLlmDecisionsSection algorithmId={algo.id} />
        </div>
      )}
      <div className="mt-4">
        <AlgoSetupZone
          algo={algo}
          aiBacktestError={aiBacktestError}
          onRunAiBacktest={onRunAiBacktest}
          isAiPending={isAiPending}
        />
      </div>
    </>
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

function LoadingState() {
  return (
    <ContentShell>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-4 h-64 w-full" />
    </ContentShell>
  );
}

function NotFoundState() {
  return (
    <ContentShell>
      <div className="mx-auto max-w-2xl py-16 text-center">
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
    </ContentShell>
  );
}

export default function AlgorithmDetailPage() {
  const { algoId } = useParams<{ algoId: string }>();
  const s = useAlgoDetailState(algoId);

  if (s.isLoading) return <LoadingState />;
  if (!s.algo) return <NotFoundState />;

  const algo = s.algo;

  return (
    <ContentShell
      inspector={
        s.isEditing ? undefined : (
          <AlgoInspectorRail algorithmId={algo.id} algorithmStatus={algo.status} />
        )
      }
    >
      <div className="mb-4">
        <AlgoHeader
          name={algo.name}
          status={algo.status}
          isEditing={s.isEditing}
          onEdit={() => s.setIsEditing(true)}
          onDelete={() => s.setShowDelete(true)}
        />
      </div>
      {s.showRerunPrompt && (
        <div className="mb-4">
          <RerunPrompt onDismiss={() => s.setShowRerunPrompt(false)} />
        </div>
      )}
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
    </ContentShell>
  );
}
