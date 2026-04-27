"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BacktestFormProps {
  onSubmit: (symbol: string, period: string) => void;
  disabled: boolean;
  assetClass?: string;
  /** Algorithm timeframe ("1h", "4h", "1d", ...) — drives sensible period defaults. */
  timeframe?: string;
}

function placeholderFor(assetClass?: string): string {
  if (assetClass === "forex") return "EUR/USD";
  if (assetClass === "commodity") return "XAU/USD";
  if (assetClass === "crypto") return "BTC/USD";
  return "AAPL";
}

function isIntraday(timeframe?: string): boolean {
  if (!timeframe) return false;
  const t = timeframe.toLowerCase();
  return t === "1h" || t === "4h" || t.endsWith("min") || t.endsWith("m");
}

/**
 * Twelve Data returns up to 100 ("compact") or 5000 ("full") bars. The number
 * of trading days that represents depends entirely on the bar interval —
 * 100 daily bars is ~5 months, 100 1h bars is ~4 trading days. Intraday
 * algos must default to "full" or the backtest is statistical noise.
 */
function describePeriod(period: string, timeframe?: string): string {
  if (period === "full") {
    if (timeframe === "1h") return "Full history (~7 months of 1h)";
    if (timeframe === "4h") return "Full history (~2 years of 4h)";
    return "Full history (5000 bars)";
  }
  if (timeframe === "1h") return "Last 100 bars (~4 days of 1h)";
  if (timeframe === "4h") return "Last 100 bars (~16 days of 4h)";
  return "Last 100 bars (~100 days of 1d)";
}

export function BacktestForm({ onSubmit, disabled, assetClass, timeframe }: BacktestFormProps) {
  const [symbol, setSymbol] = useState("");
  const intraday = isIntraday(timeframe);
  // Intraday strategies need 5000 bars to show meaningful results;
  // 100 1h bars is barely 4 days of price action.
  const [period, setPeriod] = useState<string>(intraday ? "full" : "compact");

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bt-symbol">Symbol</Label>
          <Input
            id="bt-symbol"
            placeholder={placeholderFor(assetClass)}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Period</Label>
          <Select value={period} onValueChange={(v) => setPeriod(v ?? "compact")}>
            <SelectTrigger className="w-full">
              <SelectValue>{describePeriod(period, timeframe)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">{describePeriod("compact", timeframe)}</SelectItem>
              <SelectItem value="full">{describePeriod("full", timeframe)}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button
        disabled={disabled || !symbol.trim()}
        onClick={() => onSubmit(symbol.trim(), period)}
        className="w-full"
      >
        {disabled ? "Running..." : "Run Backtest"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {intraday
          ? "Intraday backtests fetch full history by default — short windows (compact) are usually too small to be meaningful."
          : "Uses the cached price feed; daily bars from Twelve Data → Yahoo → Alpha Vantage."}
      </p>
    </div>
  );
}
