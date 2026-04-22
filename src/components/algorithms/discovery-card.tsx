"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { seedWatchlist, type SeedResult } from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function SeedResults({ data }: { data: SeedResult }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-semibold">{data.discovered}</p>
          <p className="text-[10px] text-muted-foreground">Discovered</p>
        </div>
        <div>
          <p className="text-lg font-semibold">{data.backtested}</p>
          <p className="text-[10px] text-muted-foreground">Backtested</p>
        </div>
        <div>
          <p className="text-lg font-semibold text-[var(--profit)]">{data.profitable}</p>
          <p className="text-[10px] text-muted-foreground">Profitable</p>
        </div>
      </div>
      {data.added.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Added to watchlist</p>
          <div className="flex flex-wrap gap-1">
            {data.added.map((s) => (
              <Badge key={s.ticker} variant="secondary" className="text-xs">
                {s.ticker}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {data.added.length === 0 && data.discovered > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          No tickers were profitable in backtesting. Try adjusting the algorithm rules.
        </p>
      )}
    </div>
  );
}

export function DiscoveryCard({ algorithmId }: { algorithmId: string }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<SeedResult | null>(null);
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
      } else {
        setError(res.error);
      }
    } catch {
      setError("Discovery failed. Please try again.");
    } finally {
      setIsRunning(false);
    }
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
          AI discovers tickers matching your strategy, backtests each one, and adds only the profitable ones to your watchlist.
        </p>
        <Button variant="outline" size="sm" onClick={handleSeed} disabled={isRunning} className="w-full">
          {isRunning ? <><Loader2 className="mr-2 h-3 w-3 animate-spin" />Discovering &amp; screening...</> : "Discover & Screen Tickers"}
        </Button>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {result && <SeedResults data={result} />}
      </CardContent>
    </Card>
  );
}
