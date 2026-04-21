"use client";

import Link from "next/link";
import { Bot, Plus } from "lucide-react";
import { AlgorithmCard } from "@/components/algorithms/algorithm-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgorithmsList } from "@/hooks/use-algorithms";

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Bot className="h-8 w-8 text-muted-foreground mb-3" />
      <p className="text-sm text-muted-foreground">No algorithms yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        Let AI design a trading strategy based on your preferences.
      </p>
      <Button
        className="mt-4"
        size="sm"
        render={<Link href="/algorithms/generate" />}
        nativeButton={false}
      >
        Generate your first algorithm
      </Button>
    </div>
  );
}

export default function AlgorithmsPage() {
  const { data: algorithms, isLoading } = useAlgorithmsList();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Algorithms</h1>
          <p className="text-sm text-muted-foreground">
            AI-generated trading strategies and backtesting.
          </p>
        </div>
        <Button
          size="sm"
          render={<Link href="/algorithms/generate" />}
          nativeButton={false}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Generate New
        </Button>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      )}
      {!isLoading && (!algorithms || algorithms.length === 0) && <EmptyState />}
      {!isLoading && algorithms && algorithms.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {algorithms.map((algo) => (
            <AlgorithmCard key={algo.id} algorithm={algo} />
          ))}
        </div>
      )}
    </div>
  );
}
