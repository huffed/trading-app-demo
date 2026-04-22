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
}

export function BacktestForm({ onSubmit, disabled }: BacktestFormProps) {
  const [symbol, setSymbol] = useState("");
  const [period, setPeriod] = useState("compact");

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bt-symbol">Symbol</Label>
          <Input
            id="bt-symbol"
            placeholder="AAPL"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Period</Label>
          <Select value={period} onValueChange={(v) => setPeriod(v ?? "compact")}>
            <SelectTrigger className="w-full">
              <SelectValue>{period === "compact" ? "Last 100 days" : "Full history"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Last 100 days</SelectItem>
              <SelectItem value="full">Full history (premium)</SelectItem>
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
        Uses Alpha Vantage (25 free requests/day)
      </p>
    </div>
  );
}
