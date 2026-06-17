"use client";

import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import type { BacktestTradeRow } from "@/app/(dashboard)/backtest/actions";
import type { ChartTimeframe } from "@/app/(dashboard)/chart/actions";
import { TradeDetail } from "@/components/backtest/trade-detail";
import { TradeList } from "@/components/backtest/trade-list";
import { KlineChart } from "@/components/chart/kline-chart";
import { DEFAULT_LAYERS, type LayerConfig } from "@/components/chart/layer-config";
import { LayerTogglePanel } from "@/components/chart/layer-toggle-panel";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAlgoTrades } from "@/hooks/use-algo-trades";
import { useAlgorithmsList } from "@/hooks/use-algorithms";
import { useChartData } from "@/hooks/use-chart-data";
import { useWatchlist } from "@/hooks/use-watchlist";

function deriveTimeframeForAlgo(
  algorithmId: string | null,
  algos: ReturnType<typeof useAlgorithmsList>["data"]
): ChartTimeframe {
  if (!algorithmId || !algos) return "1h";
  const a = algos.find((x) => x.id === algorithmId);
  const tf = (a?.rules as unknown as { timeframe?: string } | undefined)?.timeframe;
  if (tf === "15min" || tf === "30min" || tf === "1h" || tf === "4h" || tf === "1day") return tf;
  return "1h";
}

export default function BacktestPage() {
  const { data: algos = [], isLoading: algosLoading } = useAlgorithmsList();
  const [pickedAlgorithmId, setPickedAlgorithmId] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerConfig>(DEFAULT_LAYERS);

  // Effective algorithm = user selection, fall back to first algo so the
  // page is useful on initial render without a useEffect+setState cycle.
  const algorithmId = pickedAlgorithmId ?? algos[0]?.id ?? null;

  // Watchlist is stored in a separate table, NOT joined into algorithms.
  // useAlgorithmsList does a plain SELECT * so algorithm_watchlist is
  // never populated — fetch it via useWatchlist instead.
  const { data: watchlist } = useWatchlist(algorithmId);
  const ticker = watchlist?.[0]?.ticker ?? null;
  const timeframe = useMemo(
    () => deriveTimeframeForAlgo(algorithmId, algos),
    [algorithmId, algos]
  );

  const { data: trades, isLoading: tradesLoading } = useAlgoTrades(algorithmId);
  const { data: chartData, isLoading: chartLoading } = useChartData(
    ticker ?? "",
    timeframe,
    "full"
  );

  // Derived selection — invalidates naturally when algorithm changes because
  // the trades list changes too. No setState-in-effect needed.
  const selected: BacktestTradeRow | null =
    trades?.find((t) => t.id === selectedTradeId) ?? null;

  return (
    <div className="space-y-4">
      <Header
        algos={algos}
        algorithmId={algorithmId}
        algosLoading={algosLoading}
        onAlgorithmChange={setPickedAlgorithmId}
        ticker={ticker}
        timeframe={timeframe}
      />

      {!ticker && !algosLoading && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-muted-foreground">
              This algorithm has no watchlist ticker — pick one with a ticker to load chart history.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {ticker && chartLoading && <Skeleton className="h-[480px] w-full rounded-md" />}
        {ticker && chartData && !chartLoading && (
          <Card>
            <CardContent className="p-3">
              <KlineChart
                data={chartData}
                layers={layers}
                timeframe={timeframe}
                focusTime={selected ? new Date(selected.opened_at).getTime() / 1000 : null}
              />
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr_minmax(280px,320px)]">
          <TradeList
            trades={trades}
            isLoading={tradesLoading}
            selectedId={selected?.id ?? null}
            onSelect={(t) => setSelectedTradeId(t.id)}
          />
          <LayerTogglePanel layers={layers} onChange={setLayers} />
          {selected ? (
            // key remount on trade change so TradeDetail's data fetch
            // resets cleanly without setState-in-effect.
            <TradeDetail key={selected.id} trade={selected} />
          ) : (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">
                  Pick a trade on the left to see full details and focus the chart on its
                  entry-time window.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({
  algos,
  algorithmId,
  algosLoading,
  onAlgorithmChange,
  ticker,
  timeframe,
}: {
  algos: ReturnType<typeof useAlgorithmsList>["data"];
  algorithmId: string | null;
  algosLoading: boolean;
  onAlgorithmChange: (id: string) => void;
  ticker: string | null;
  timeframe: string;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Backtest replay</h1>
        <p className="text-sm text-muted-foreground">
          Per-algorithm trade history with full-history chart. Click a trade to zoom to its
          entry-time window and see protection, P&amp;L, MAE/MFE side by side.
        </p>
      </div>
      <Card>
        <CardContent className="p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Algorithm</Label>
              {algosLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={algorithmId ?? undefined}
                  onValueChange={(v) => v && onAlgorithmChange(v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an algorithm" />
                  </SelectTrigger>
                  <SelectContent>
                    {algos?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Symbol / TF</Label>
              <div className="rounded-md border px-3 py-2 text-sm font-medium">
                {ticker ?? "—"} <span className="text-muted-foreground ml-2">{timeframe}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
