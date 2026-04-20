"use client";

import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAnalyzeJournalEntry } from "@/hooks/use-journal";

interface AiAnalysisCardProps {
  entryId: string;
  analysis: string | null;
  analyzedAt: string | null;
}

function AnalysisContent({ analysis }: { analysis: string }) {
  return (
    <div className="space-y-1">
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {analysis}
      </div>
    </div>
  );
}

function AnalysisPlaceholder() {
  return (
    <p className="text-sm text-muted-foreground">
      AI analysis will appear here once the entry is saved. It will review your
      decisions and emotions to help identify patterns in your trading.
    </p>
  );
}

export function AiAnalysisCard({ entryId, analysis, analyzedAt }: AiAnalysisCardProps) {
  const analyze = useAnalyzeJournalEntry();

  return (
    <Card className="border-dashed">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">AI Analysis</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={analyze.isPending}
            onClick={() => analyze.mutate(entryId)}
          >
            {analyze.isPending ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3 w-3" />
            )}
            {analysis ? "Re-analyze" : "Analyze"}
          </Button>
        </div>
        {analyze.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing your entry...
          </div>
        )}
        {!analyze.isPending && analysis && <AnalysisContent analysis={analysis} />}
        {!analyze.isPending && !analysis && <AnalysisPlaceholder />}
        {analyzedAt && !analyze.isPending && (
          <p className="text-xs text-muted-foreground">
            Last analyzed {new Date(analyzedAt).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
