"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StrategyMatrixRow } from "@/lib/performance/strategy-matrix";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--glass-border-strong)",
  borderRadius: "8px",
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};

function fmtCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Aggregates per-algo backtest returns by ticker. Useful for spotting
 *  which instrument is producing the most strategy-portfolio R. */
function byTicker(rows: StrategyMatrixRow[]): { ticker: string; total: number; algos: number }[] {
  const map = new Map<string, { total: number; algos: number }>();
  for (const r of rows) {
    if (r.ticker == null || r.total_return == null) continue;
    const bucket = map.get(r.ticker) ?? { total: 0, algos: 0 };
    bucket.total += r.total_return;
    bucket.algos++;
    map.set(r.ticker, bucket);
  }
  return [...map.entries()]
    .map(([ticker, v]) => ({ ticker, total: Math.round(v.total), algos: v.algos }))
    .sort((a, b) => b.total - a.total);
}

/** Aggregates per-algo backtest returns by strategy umbrella. Useful for
 *  spotting which strategy is the workhorse across the library. */
function byStrategy(rows: StrategyMatrixRow[]): { strategy: string; total: number; algos: number }[] {
  const map = new Map<string, { total: number; algos: number }>();
  for (const r of rows) {
    if (r.total_return == null) continue;
    const key = r.strategy_name ?? "Standalone";
    const bucket = map.get(key) ?? { total: 0, algos: 0 };
    bucket.total += r.total_return;
    bucket.algos++;
    map.set(key, bucket);
  }
  return [...map.entries()]
    .map(([strategy, v]) => ({ strategy, total: Math.round(v.total), algos: v.algos }))
    .sort((a, b) => b.total - a.total);
}

export function ReturnsByTickerChart({ rows }: { rows: StrategyMatrixRow[] }) {
  const data = useMemo(() => byTicker(rows), [rows]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Total backtest $ by ticker</CardTitle>
        <p className="text-xs text-muted-foreground">
          Summed total return across all algos on each instrument. Concentration risk: 1 instrument
          carrying the library = vulnerable to regime drift on that pair.
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
            No tickers with backtest data.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="ticker" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v) => fmtCurrency(Number(v))}
              />
              <Bar dataKey="total" name="Total $" radius={[4, 4, 0, 0]}>
                {data.map((d) => (
                  <Cell
                    key={d.ticker}
                    fill={d.total >= 0 ? "var(--profit)" : "var(--loss)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function ReturnsByStrategyChart({ rows }: { rows: StrategyMatrixRow[] }) {
  const data = useMemo(() => byStrategy(rows), [rows]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Total backtest $ by strategy</CardTitle>
        <p className="text-xs text-muted-foreground">
          Summed total return across all instances of each strategy umbrella. Identifies the
          workhorse strategies vs the tail.
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
            No strategies with backtest data.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="strategy"
                tick={{ fontSize: 10 }}
                interval={0}
                angle={-25}
                textAnchor="end"
                height={75}
              />
              <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v) => fmtCurrency(Number(v))}
              />
              <Bar dataKey="total" name="Total $" radius={[4, 4, 0, 0]}>
                {data.map((d) => (
                  <Cell
                    key={d.strategy}
                    fill={d.total >= 0 ? "var(--profit)" : "var(--loss)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
