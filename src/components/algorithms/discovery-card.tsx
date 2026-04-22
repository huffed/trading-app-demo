"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { seedWatchlist, type ScreenedTicker, type ScreenResult } from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { pnlColorClass } from "@/lib/utils/pnl";

function TickerRow({ ticker }: { ticker: ScreenedTicker }) {
  const m = ticker.metrics;
  return (
    <div className="py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium">{ticker.ticker}</span>
        <span className="text-xs text-muted-foreground truncate flex-1">{ticker.name}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">{ticker.sector}</Badge>
        {ticker.profitable
          ? <Check className="h-3.5 w-3.5 text-[var(--profit)] shrink-0" />
          : <X className="h-3.5 w-3.5 text-[var(--loss)] shrink-0" />}
      </div>
      {m && (
        <div className="flex gap-3 text-xs">
          <span className={`font-medium tabular-nums ${pnlColorClass(m.total_return)}`}>
            {m.total_return >= 0 ? "+" : ""}{m.total_return.toFixed(1)}%
          </span>
          <span className="text-muted-foreground tabular-nums">{m.win_rate.toFixed(0)}% win</span>
          <span className="text-muted-foreground tabular-nums">{m.total_trades} trades</span>
        </div>
      )}
      {!m && <p className="text-xs text-[var(--loss)]">Backtest failed</p>}
      <p className="text-xs text-muted-foreground leading-relaxed">{ticker.analysis}</p>
    </div>
  );
}

function ScreenResults({ data }: { data: ScreenResult }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{data.tickers.length} screened</span>
        <span className="text-[var(--profit)]">{data.added} profitable &amp; added</span>
        <span className="text-[var(--loss)]">{data.tickers.length - data.added} filtered out</span>
      </div>
      <div className="divide-y">
        {data.tickers.map((t) => <TickerRow key={t.ticker} ticker={t} />)}
      </div>
    </div>
  );
}

export function DiscoveryCard({ algorithmId }: { algorithmId: string }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSeed() {
    setIsRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await seedWatchlist(algorithmId);
      if (res.success) {
        setResult(res.data);
        queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      } else { setError(res.error); }
    } catch { setError("Discovery failed. Please try again."); }
    finally { setIsRunning(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4" />Discovery Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          AI discovers tickers, backtests each against your rules, and adds profitable ones to your watchlist.
        </p>
        <Button variant="outline" size="sm" onClick={handleSeed} disabled={isRunning} className="w-full">
          {isRunning ? <><Loader2 className="mr-2 h-3 w-3 animate-spin" />Discovering &amp; screening...</> : "Discover & Screen"}
        </Button>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {result && <ScreenResults data={result} />}
      </CardContent>
    </Card>
  );
}
