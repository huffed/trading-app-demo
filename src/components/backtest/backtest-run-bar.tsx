"use client";

import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface RunMeta {
  run_at: string;
  trade_count: number;
}

function runBarCopy(meta: RunMeta | null, llmTrader: boolean): string {
  if (meta) {
    return `${meta.trade_count} trades · last run ${new Date(meta.run_at).toLocaleString()}`;
  }
  if (llmTrader) {
    return "LLM-trader algorithms can't be replayed from this page yet — per-bar LLM calls would burn the monthly budget. Use the harness scripts.";
  }
  return "No backtest run yet. Click below to replay this algorithm's full history.";
}

export function BacktestRunBar({
  meta,
  llmTrader,
  algorithmId,
  isPending,
  error,
  onRun,
}: {
  meta: RunMeta | null;
  llmTrader: boolean;
  algorithmId: string | null;
  isPending: boolean;
  error: string | null;
  onRun: (id: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="text-xs text-muted-foreground">{runBarCopy(meta, llmTrader)}</div>
        {!llmTrader && algorithmId && (
          <Button size="sm" onClick={() => onRun(algorithmId)} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Running…
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" /> {meta ? "Re-run backtest" : "Run backtest"}
              </>
            )}
          </Button>
        )}
        {error && <p className="text-xs text-[var(--loss)] w-full">{error}</p>}
      </CardContent>
    </Card>
  );
}
