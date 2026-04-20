"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { AiBacktestCard } from "@/components/algorithms/ai-backtest-card";
import { BacktestForm } from "@/components/algorithms/backtest-form";
import { BacktestResultsDisplay } from "@/components/algorithms/backtest-results-display";
import { RulesDisplay } from "@/components/algorithms/rules-display";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgorithm, useDeleteAlgorithm, useRunAiBacktest, useRunHistoricalBacktest } from "@/hooks/use-algorithms";
import type { BacktestMetrics } from "@/lib/market-data/types";

const statusColors: Record<string, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  archived: "secondary",
};

function AlgoHeader({ name, status, onDelete }: { name: string; status: string; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm" render={<Link href="/algorithms" />} nativeButton={false}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      </div>
      <Badge variant={statusColors[status] ?? "secondary"}>{status}</Badge>
      <Button variant="ghost" size="icon-sm" onClick={onDelete}>
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

function AlgoDescription({ description }: { description: string }) {
  if (!description) return null;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{description}</div>
      </CardContent>
    </Card>
  );
}

export default function AlgorithmDetailPage() {
  const { algoId } = useParams<{ algoId: string }>();
  const router = useRouter();
  const { data: algo, isLoading } = useAlgorithm(algoId);
  const deleteMutation = useDeleteAlgorithm();
  const backtestMutation = useRunAiBacktest();
  const historicalBacktest = useRunHistoricalBacktest();
  const [showDelete, setShowDelete] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!algo) {
    return (
      <div className="mx-auto max-w-2xl text-center py-16">
        <p className="text-sm text-muted-foreground">Algorithm not found</p>
        <Button className="mt-4" variant="outline" render={<Link href="/algorithms" />} nativeButton={false}>
          Back to Algorithms
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AlgoHeader name={algo.name} status={algo.status} onDelete={() => setShowDelete(true)} />
      <AlgoDescription description={algo.description} />
      <RulesDisplay rules={algo.rules} />
      <AiBacktestCard
        analysis={algo.ai_analysis}
        onRunBacktest={() => backtestMutation.mutate(algo.id)}
        isPending={backtestMutation.isPending}
      />
      <BacktestForm
        disabled={historicalBacktest.isPending}
        onSubmit={(symbol, period) => {
          setBacktestError(null);
          historicalBacktest.mutate(
            { id: algo.id, symbol, period: period as "compact" | "full" },
            { onError: () => setBacktestError("Backtest failed. Check symbol and try again.") }
          );
        }}
      />
      {backtestError && (
        <p className="text-sm text-destructive">{backtestError}</p>
      )}
      {algo.backtest_results && (
        <BacktestResultsDisplay results={algo.backtest_results as BacktestMetrics} />
      )}

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Delete Algorithm</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{algo.name}&rdquo;? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setShowDelete(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                deleteMutation.mutate(algo.id, { onSuccess: () => router.push("/algorithms") });
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
