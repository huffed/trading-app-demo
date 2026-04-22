"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { AiBacktestCard } from "@/components/algorithms/ai-backtest-card";
import { AlgorithmEditView } from "@/components/algorithms/algorithm-edit-view";
import { BacktestForm } from "@/components/algorithms/backtest-form";
import { BacktestResultsDisplay } from "@/components/algorithms/backtest-results-display";
import { LiveSignalCard } from "@/components/algorithms/live-signal-card";
import { RulesDisplay } from "@/components/algorithms/rules-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgorithm, useDeleteAlgorithm, useRunAiBacktest, useRunHistoricalBacktest, useUpdateAlgorithm } from "@/hooks/use-algorithms";
import { STATUS_COLORS } from "@/lib/constants/algorithm";
import type { BacktestMetrics } from "@/lib/market-data/types";
import { isSentimentCondition, type Algorithm, type AlgorithmRules, type AlgorithmStatus } from "@/types/algorithm";

function AlgoHeader({ name, status, isEditing, onEdit, onDelete }: {
  name: string; status: string; isEditing: boolean; onEdit: () => void; onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm" render={<Link href="/algorithms" />} nativeButton={false}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      </div>
      <Badge variant={STATUS_COLORS[status] ?? "secondary"}>{status}</Badge>
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

function DeleteAlgoDialog({ name, open, onOpenChange, isPending, onConfirm }: {
  name: string; open: boolean; onOpenChange: (v: boolean) => void; isPending: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Delete Algorithm</DialogTitle>
          <DialogDescription>Delete &ldquo;{name}&rdquo;? This cannot be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={isPending} onClick={onConfirm}>{isPending ? "Deleting..." : "Delete"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadView({ algo, backtestError, aiBacktestError, localBacktestResults, onRunAiBacktest, onRunBacktest, isAiPending, isBtPending }: {
  algo: Pick<Algorithm, "id" | "name" | "description" | "rules" | "ai_analysis" | "backtest_results">;
  backtestError: string | null; aiBacktestError: string | null; localBacktestResults: BacktestMetrics | null;
  onRunAiBacktest: () => void; onRunBacktest: (symbol: string, period: string) => void; isAiPending: boolean; isBtPending: boolean;
}) {
  return (
    <>
      {algo.description && (
        <Card><CardContent className="p-4"><div className="whitespace-pre-wrap text-sm leading-relaxed">{algo.description}</div></CardContent></Card>
      )}
      <RulesDisplay rules={algo.rules} />
      <AiBacktestCard analysis={algo.ai_analysis} error={aiBacktestError} onRunBacktest={onRunAiBacktest} isPending={isAiPending} />
      <BacktestForm disabled={isBtPending} onSubmit={onRunBacktest} />
      {algo.rules.entry_conditions.some(isSentimentCondition) && <LiveSignalCard algorithmId={algo.id} />}
      {backtestError && <p className="text-sm text-destructive">{backtestError}</p>}
      {(localBacktestResults || algo.backtest_results) && (
        <BacktestResultsDisplay results={(localBacktestResults ?? algo.backtest_results) as BacktestMetrics} />
      )}
    </>
  );
}

export default function AlgorithmDetailPage() {
  const { algoId } = useParams<{ algoId: string }>();
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

  if (isLoading) {
    return <div className="mx-auto max-w-2xl space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }
  if (!algo) {
    return (
      <div className="mx-auto max-w-2xl text-center py-16">
        <p className="text-sm text-muted-foreground">Algorithm not found</p>
        <Button className="mt-4" variant="outline" render={<Link href="/algorithms" />} nativeButton={false}>Back to Algorithms</Button>
      </div>
    );
  }

  function handleSave(updates: { name: string; description: string; status: AlgorithmStatus; rules: AlgorithmRules }) {
    const rulesChanged = JSON.stringify(updates.rules) !== JSON.stringify(algo!.rules);
    updateMutation.mutate({ id: algoId, updates }, {
      onSuccess: (r) => {
        if (r.success) { setIsEditing(false); if (rulesChanged) { setShowRerunPrompt(true); } }
      },
    });
  }

  function handleHistoricalBacktest(symbol: string, period: string) {
    setBacktestError(null);
    setShowRerunPrompt(false);
    historicalBacktest.mutate(
      { id: algoId, symbol, period: period as "compact" | "full" },
      {
        onSuccess: (r) => { if (!r.success) { setBacktestError(r.error); } else { setLocalBacktestResults(r.data as BacktestMetrics); } },
        onError: () => setBacktestError("Backtest failed. Check symbol and try again."),
      }
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AlgoHeader name={algo.name} status={algo.status} isEditing={isEditing} onEdit={() => setIsEditing(true)} onDelete={() => setShowDelete(true)} />
      {showRerunPrompt && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
          <span className="text-sm">Rules updated — re-run backtest?</span>
          <Button size="sm" variant="outline" onClick={() => setShowRerunPrompt(false)}>Dismiss</Button>
        </div>
      )}
      {isEditing ? (
        <AlgorithmEditView algorithm={algo} onSave={handleSave} onCancel={() => setIsEditing(false)} isSaving={updateMutation.isPending} />
      ) : (
        <ReadView
          algo={algo} backtestError={backtestError} aiBacktestError={aiBacktestError} localBacktestResults={localBacktestResults}
          onRunAiBacktest={() => { setAiBacktestError(null); backtestMutation.mutate(algo.id, { onSuccess: (r) => { if (!r.success) { setAiBacktestError(r.error); } } }); }}
          onRunBacktest={handleHistoricalBacktest} isAiPending={backtestMutation.isPending} isBtPending={historicalBacktest.isPending}
        />
      )}
      <DeleteAlgoDialog name={algo.name} open={showDelete} onOpenChange={setShowDelete} isPending={deleteMutation.isPending}
        onConfirm={() => { deleteMutation.mutate(algo.id, { onSuccess: () => router.push("/algorithms") }); }} />
    </div>
  );
}
