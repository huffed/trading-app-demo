"use client";

import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface AiBacktestCardProps {
  analysis: string | null;
  onRunBacktest: () => void;
  isPending: boolean;
}

export function AiBacktestCard({ analysis, onRunBacktest, isPending }: AiBacktestCardProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">AI Backtest Analysis</span>
          </div>
          <Button variant="ghost" size="sm" disabled={isPending} onClick={onRunBacktest}>
            {isPending ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3 w-3" />
            )}
            {analysis ? "Re-analyze" : "Run Analysis"}
          </Button>
        </div>
        {isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Evaluating algorithm against your trade history...
          </div>
        )}
        {!isPending && analysis && (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{analysis}</div>
        )}
        {!isPending && !analysis && (
          <p className="text-sm text-muted-foreground">
            Run an AI analysis to evaluate this algorithm against your trading history.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
