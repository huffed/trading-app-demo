"use client";

import { useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ChartTimeframe } from "@/app/(dashboard)/chart/actions";
import { TradingChart } from "@/components/chart/trading-chart";
import { Button } from "@/components/ui/button";
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
import { useAlgorithmsList } from "@/hooks/use-algorithms";
import { useChartData } from "@/hooks/use-chart-data";

const TIMEFRAMES: ChartTimeframe[] = ["15min", "30min", "1h", "4h", "1day"];

/** Default ticker list — instruments the operator's library currently
 *  trades. Picker is editable, so any ticker the provider supports
 *  can be entered manually if needed. */
const DEFAULT_TICKERS = ["XAU/USD", "USD/JPY", "EUR/USD", "GBP/USD"];

export default function ChartPage() {
  const [ticker, setTicker] = useState("XAU/USD");
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("4h");
  const [outputSize, setOutputSize] = useState<"compact" | "full">("compact");
  const [tickerDraft, setTickerDraft] = useState(ticker);

  const { data, isLoading, isError, error, refetch, isFetching } = useChartData(
    ticker,
    timeframe,
    outputSize
  );

  // Available algorithms — used to inform the operator about which
  // tickers have an active strategy on them.
  const { data: algos = [] } = useAlgorithmsList();
  const tickersWithAlgos = new Set<string>();
  for (const a of algos) {
    if (a.status === "active") {
      const watchlist = (
        a as unknown as { algorithm_watchlist?: { ticker: string }[] }
      ).algorithm_watchlist;
      for (const w of watchlist ?? []) tickersWithAlgos.add(w.ticker);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Chart</h1>
        <p className="text-sm text-muted-foreground">
          Live technical analysis chart for any instrument the price provider supports. Markers show
          your own paper-trade entries and exits with realized R.
        </p>
      </div>

      <Controls
        ticker={tickerDraft}
        timeframe={timeframe}
        outputSize={outputSize}
        onTickerChange={setTickerDraft}
        onTickerCommit={(t) => setTicker(t)}
        onTimeframeChange={setTimeframe}
        onOutputSizeChange={setOutputSize}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load chart data</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading && <Skeleton className="h-[480px] w-full rounded-md" />}

      {data && !isLoading && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <ChartHeader
              ticker={data.ticker}
              timeframe={data.timeframe}
              barCount={data.bars.length}
              markerCount={data.markers.length}
              hasActiveAlgo={tickersWithAlgos.has(data.ticker)}
            />
            <TradingChart bars={data.bars} sma20={data.sma20} markers={data.markers} />
            <Legend />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TickerField({
  ticker,
  onChange,
  onCommit,
}: {
  ticker: string;
  onChange: (t: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">Ticker</Label>
      <div className="flex gap-1.5">
        <Select value={ticker} onValueChange={(v) => v && onChange(v)}>
          <SelectTrigger className="w-full">
            <SelectValue>{ticker}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_TICKERS.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={onCommit}>
          Load
        </Button>
      </div>
    </div>
  );
}

function PickField<T extends string>({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as T)}>
        <SelectTrigger className="w-full">
          <SelectValue>{format ? format(value) : value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {format ? format(o) : o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Controls({
  ticker,
  timeframe,
  outputSize,
  onTickerChange,
  onTickerCommit,
  onTimeframeChange,
  onOutputSizeChange,
  onRefresh,
  isFetching,
}: {
  ticker: string;
  timeframe: ChartTimeframe;
  outputSize: "compact" | "full";
  onTickerChange: (t: string) => void;
  onTickerCommit: (t: string) => void;
  onTimeframeChange: (t: ChartTimeframe) => void;
  onOutputSizeChange: (s: "compact" | "full") => void;
  onRefresh: () => void;
  isFetching: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TickerField
            ticker={ticker}
            onChange={onTickerChange}
            onCommit={() => onTickerCommit(ticker)}
          />
          <PickField
            label="Timeframe"
            value={timeframe}
            options={TIMEFRAMES}
            onChange={onTimeframeChange}
          />
          <PickField
            label="History"
            value={outputSize}
            options={["compact", "full"] as const}
            onChange={onOutputSizeChange}
            format={(v) => (v === "compact" ? "~100 bars" : "Full history")}
          />
          <div className="flex items-end">
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={isFetching}
              className="w-full"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChartHeader({
  ticker,
  timeframe,
  barCount,
  markerCount,
  hasActiveAlgo,
}: {
  ticker: string;
  timeframe: string;
  barCount: number;
  markerCount: number;
  hasActiveAlgo: boolean;
}) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2 px-1">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold tabular-nums">{ticker}</h2>
        <span className="text-xs text-muted-foreground">{timeframe}</span>
        {hasActiveAlgo && (
          <span className="text-[10px] uppercase tracking-wide text-[var(--profit)] font-semibold">
            active algo
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {barCount} bars · {markerCount} markers
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="h-1 w-3 bg-[rgba(120,180,230,0.9)] rounded-sm" /> SMA(20)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--profit)]">▲</span> long entry
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--loss)]">▼</span> short entry
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--profit)]">●</span> winning exit
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[var(--loss)]">■</span> losing exit
      </span>
    </div>
  );
}
