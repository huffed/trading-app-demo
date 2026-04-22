"use client";

import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { MarkdownText } from "@/components/shared/markdown-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface AiBacktestCardProps {
  analysis: string | null;
  error: string | null;
  onRunBacktest: () => void;
  isPending: boolean;
}

export function AiBacktestCard({ analysis, error, onRunBacktest, isPending }: AiBacktestCardProps) {
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
          <MarkdownText text={analysis} className="text-sm leading-relaxed space-y-1" />
        )}
        {!isPending && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        {!isPending && !analysis && !error && (
          <p className="text-sm text-muted-foreground">
            Run an AI analysis to evaluate this algorithm against your trading history.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
