"use client";

import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import type { BacktestTradeRow } from "@/app/(dashboard)/backtest/actions";
import type { ChartTimeframe } from "@/app/(dashboard)/chart/actions";
import { BacktestRunBar } from "@/components/backtest/backtest-run-bar";
import { TradeDetail } from "@/components/backtest/trade-detail";
import { TradeList } from "@/components/backtest/trade-list";
import { ChartLayersRail } from "@/components/chart/chart-layers-rail";
import { KlineChart } from "@/components/chart/kline-chart";
import { DEFAULT_LAYERS, type LayerConfig } from "@/components/chart/layer-config";
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
import { useAlgoTrades, useRunAlgorithmBacktest } from "@/hooks/use-algo-trades";
import { useAlgorithmsList } from "@/hooks/use-algorithms";
import { useChartData } from "@/hooks/use-chart-data";
import { useLivePrice } from "@/hooks/use-live-price";
import { useWatchlist } from "@/hooks/use-watchlist";

function deriveTimeframeForAlgo(
  algorithmId: string | null,
  algos: ReturnType<typeof useAlgorithmsList>["data"]
): ChartTimeframe {
  if (!algorithmId || !algos) return "1h";
  const a = algos.find((x) => x.id === algorithmId);
  const tf = a?.rules?.timeframe;
  if (tf === "15min" || tf === "30min" || tf === "1h" || tf === "4h" || tf === "1day") return tf;
  return "1h";
}

function isLlmTrader(
  algorithmId: string | null,
  algos: ReturnType<typeof useAlgorithmsList>["data"]
): boolean {
  if (!algorithmId || !algos) return false;
  const a = algos.find((x) => x.id === algorithmId);
  return a?.rules?.llm_trader?.enabled === true;
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

  const { data: tradesPayload, isLoading: tradesLoading } = useAlgoTrades(algorithmId);
  const trades = tradesPayload?.trades;
  const meta = tradesPayload?.meta ?? null;
  const llmTrader = isLlmTrader(algorithmId, algos);
  const runBacktest = useRunAlgorithmBacktest();

  const { data: chartData, isLoading: chartLoading } = useChartData(
    ticker ?? "",
    timeframe,
    "full",
    algorithmId,
    "backtest"
  );
  const { data: live } = useLivePrice(ticker ?? "");

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

      {!ticker && !algosLoading && <NoTickerNotice />}

      <div className="space-y-4">
        <ChartSection
          ticker={ticker}
          chartLoading={chartLoading}
          chartData={chartData}
          layers={layers}
          onLayersChange={setLayers}
          timeframe={timeframe}
          livePrice={live?.price ?? null}
          focusTime={selected ? new Date(selected.entry_date).getTime() / 1000 : null}
        />

        <BacktestRunBar
          meta={meta}
          llmTrader={llmTrader}
          algorithmId={algorithmId}
          isPending={runBacktest.isPending}
          error={runBacktest.error?.message ?? null}
          onRun={(id) => runBacktest.mutate(id)}
        />

        <BottomGrid
          trades={trades}
          tradesLoading={tradesLoading}
          selected={selected}
          onSelect={(id) => setSelectedTradeId(id)}
        />
      </div>
    </div>
  );
}

function ChartSection({
  ticker,
  chartLoading,
  chartData,
  layers,
  onLayersChange,
  timeframe,
  livePrice,
  focusTime,
}: {
  ticker: string | null;
  chartLoading: boolean;
  chartData: ReturnType<typeof useChartData>["data"];
  layers: LayerConfig;
  onLayersChange: (next: LayerConfig) => void;
  timeframe: ChartTimeframe;
  livePrice: number | null;
  focusTime: number | null;
}) {
  if (!ticker) return null;
  if (chartLoading) return <Skeleton className="h-[480px] w-full rounded-md" />;
  if (!chartData) return null;
  return (
    <Card>
      <CardContent className="p-3 flex gap-3">
        <div className="flex-1 min-w-0">
          <KlineChart
            data={chartData}
            layers={layers}
            timeframe={timeframe}
            livePrice={livePrice}
            focusTime={focusTime}
          />
        </div>
        <ChartLayersRail layers={layers} onChange={onLayersChange} />
      </CardContent>
    </Card>
  );
}

function BottomGrid({
  trades,
  tradesLoading,
  selected,
  onSelect,
}: {
  trades: BacktestTradeRow[] | undefined;
  tradesLoading: boolean;
  selected: BacktestTradeRow | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_minmax(280px,320px)]">
      <TradeList
        trades={trades}
        isLoading={tradesLoading}
        selectedId={selected?.id ?? null}
        onSelect={(t) => onSelect(t.id)}
      />
      {selected ? (
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
  );
}


function NoTickerNotice() {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3 text-sm">
        <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-muted-foreground">
          This algorithm has no watchlist ticker — pick one with a ticker to load chart history.
        </p>
      </CardContent>
    </Card>
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
                    <SelectValue placeholder="Select an algorithm">
                      {algos?.find((a) => a.id === algorithmId)?.name ?? ""}
                    </SelectValue>
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
