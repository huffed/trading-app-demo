"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import {
  seedWatchlist,
  type ScreenedTicker,
  type ScreenResult,
} from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { pnlColorClass } from "@/lib/utils/pnl";

function formatDelta(pct: number, suffix: string): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}${suffix}`;
}

function TickerStatusIcon({ improves }: { improves: boolean }) {
  if (improves) {
    return <Check className="h-3.5 w-3.5 text-[var(--profit)] shrink-0" />;
  }
  return <X className="h-3.5 w-3.5 text-[var(--loss)] shrink-0" />;
}

function DeltaRow({ ticker }: { ticker: ScreenedTicker }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      <span
        className={`font-medium tabular-nums ${pnlColorClass(ticker.delta_return_pct)}`}
        title="Δ portfolio return when this ticker is added"
      >
        Δ ret {formatDelta(ticker.delta_return_pct, "%")}
      </span>
      <span
        className={`tabular-nums ${
          ticker.delta_max_dd_pct > 0 ? "text-[var(--loss)]" : "text-[var(--profit)]"
        }`}
        title="Δ portfolio max drawdown"
      >
        Δ DD {formatDelta(ticker.delta_max_dd_pct, "pp")}
      </span>
      <span
        className={`tabular-nums ${
          ticker.delta_win_rate_pct >= 0 ? "text-muted-foreground" : "text-[var(--loss)]"
        }`}
        title="Δ win rate"
      >
        Δ WR {formatDelta(ticker.delta_win_rate_pct, "pp")}
      </span>
    </div>
  );
}

function TickerRow({ ticker }: { ticker: ScreenedTicker }) {
  return (
    <div className="py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium">{ticker.ticker}</span>
        <span className="text-xs text-muted-foreground truncate flex-1">{ticker.name}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {ticker.sector}
        </Badge>
        <TickerStatusIcon improves={ticker.improves_portfolio} />
      </div>
      {ticker.metrics ? (
        <DeltaRow ticker={ticker} />
      ) : (
        <p className="text-xs text-[var(--loss)]">{ticker.rejection_reason ?? "Backtest failed"}</p>
      )}
      {!ticker.improves_portfolio && ticker.rejection_reason && ticker.metrics && (
        <p className="text-[11px] text-muted-foreground italic">{ticker.rejection_reason}</p>
      )}
      <p className="text-xs text-muted-foreground leading-relaxed">{ticker.analysis}</p>
    </div>
  );
}

function BaselineSummary({ baseline }: { baseline: ScreenResult["baseline_metrics"] }) {
  if (!baseline) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-2 text-xs space-y-0.5">
      <p className="font-medium text-muted-foreground">
        Baseline portfolio (current watchlist, no candidates)
      </p>
      <div className="flex flex-wrap gap-x-3 tabular-nums">
        <span className={pnlColorClass(baseline.return_pct)}>
          {baseline.return_pct >= 0 ? "+" : ""}
          {baseline.return_pct.toFixed(2)}% return
        </span>
        <span>{baseline.max_dd_pct.toFixed(2)}% max DD</span>
        <span>{baseline.win_rate_pct.toFixed(1)}% WR</span>
        <span>{baseline.trades} trades</span>
      </div>
    </div>
  );
}

function ScreenResults({ data }: { data: ScreenResult }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{data.tickers.length} screened</span>
        <span className="text-[var(--profit)]">{data.added} improve portfolio &amp; added</span>
        <span className="text-[var(--loss)]">{data.tickers.length - data.added} filtered out</span>
      </div>
      <BaselineSummary baseline={data.baseline_metrics} />
      <div className="divide-y">
        {data.tickers.map((t) => (
          <TickerRow key={t.ticker} ticker={t} />
        ))}
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
          <Sparkles className="h-4 w-4" />
          Discovery Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          AI proposes tickers, then portfolio-backtests each one combined with your existing
          watchlist. Only candidates that improve the portfolio (return goes up, drawdown
          doesn&apos;t worsen by more than 1pp) are added. Slower than naive screening — runs one
          backtest per candidate plus the baseline.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSeed}
          disabled={isRunning}
          className="w-full"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Discovering &amp; portfolio-screening...
            </>
          ) : (
            "Discover & Screen"
          )}
        </Button>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {result && <ScreenResults data={result} />}
      </CardContent>
    </Card>
  );
}
