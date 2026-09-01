"use client";

/**
 * Hero equity curve — portfolio-wide cumulative pnl from closed paper
 * positions over the last 30 days. The dominant visual on the
 * dashboard fold; uses a glass `Surface` with a soft area chart.
 *
 * Cumulative reduction lives in `lib/utils/equity-curve`; broker-truth
 * filter stays here because it's display-layer (broker_close_price
 * fallback to realized_pnl).
 */
import { useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { useClosedPositionsWindow } from "@/hooks/use-paper-trading";
import { M1_BASELINE } from "@/lib/cohort/m1-baseline";
import { computeEquityCurve } from "@/lib/utils/equity-curve";
import { displayedPnl, formatCurrency, formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";

interface CurvePoint {
  date: string;
  value: number;
}

function buildCurve(positions: PaperPosition[]): CurvePoint[] {
  // Use broker-truth realized P&L when set (broker_close_price + broker_fill_price),
  // fall back to system realized_pnl otherwise. Curve reflects what FTMO
  // actually shows, not paper math.
  return computeEquityCurve(
    positions
      .filter((p) => p.closed_at && (p.realized_pnl != null || p.broker_close_price != null))
      .map((p) => ({ realized_pnl: displayedPnl(p) ?? 0, closed_at: p.closed_at! }))
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--glass-border-strong)",
  borderRadius: "8px",
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};

/** Range presets — display FILTERS over the untouched position history
 *  (2026-09-01). "M1" = the current portfolio's evidence-clock record;
 *  "All" includes retired pre-M1 configs. */
const RANGES = [
  { key: "m1", label: "M1", days: null as number | null, since: M1_BASELINE.clock_start },
  { key: "30d", label: "30d", days: 30 as number | null, since: undefined },
  { key: "all", label: "All", days: null as number | null, since: undefined },
];

export function EquityHero() {
  const [rangeKey, setRangeKey] = useState("m1");
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0];
  const { data: positions = [], isLoading } = useClosedPositionsWindow(
    undefined,
    range.days,
    range.since
  );
  const curve = useMemo(() => buildCurve(positions), [positions]);
  const total = curve.length > 0 ? curve[curve.length - 1].value : 0;
  const tradeCount = curve.length;

  return (
    <Surface elevation="mid" className="p-5 lg:col-span-12">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Cumulative P&amp;L
          </p>
          {isLoading ? (
            <Skeleton className="mt-1 h-9 w-32" />
          ) : (
            <p className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${pnlColorClass(total)}`}>
              {formatPnl(total)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border border-glass-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRangeKey(r.key)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  r.key === rangeKey
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Badge variant="outline" className="border-glass-border">
            <TrendingUp className="mr-1 h-3 w-3" /> {tradeCount} closes · {range.label}
          </Badge>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-44 w-full" />
      ) : curve.length < 2 ? (
        <p className="py-12 text-center text-xs text-muted-foreground">
          Need at least 2 closed paper trades in this range to plot a curve.
          {tradeCount === 1 && " Found 1 — waiting for the next close."}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={curve} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="equityHeroGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
                <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => formatCurrency(v)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [formatCurrency(Number(value)), "P&L"]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="var(--color-chart-1)"
              fill="url(#equityHeroGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Surface>
  );
}
