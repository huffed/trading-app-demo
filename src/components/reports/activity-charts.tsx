"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyActivityPoint, EquityPoint } from "@/lib/cohort/engine-activity";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--glass-border-strong)",
  borderRadius: "8px",
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};

/** Trim the YYYY-MM-DD x-axis labels to just MM-DD to save width. */
function shortDate(date: string): string {
  return date.slice(5);
}

function fmtCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function DecisionsTimeline({ data }: { data: DailyActivityPoint[] }) {
  const hasData = data.some(
    (d) => d.holds + d.enters_long + d.enters_short + d.exits > 0
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">LLM decisions over time</CardTitle>
        <p className="text-xs text-muted-foreground">
          Stacked daily counts of what the LLM-trader decided. Heavy <em>hold</em> dominance is
          expected — entries fire only on bar closes the prompt validates.
        </p>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <EmptyChart message="No LLM decisions in this window." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="holds" stackId="dec" fill="var(--color-muted-foreground)" name="hold" />
              <Bar
                dataKey="enters_long"
                stackId="dec"
                fill="var(--profit)"
                name="enter long"
              />
              <Bar
                dataKey="enters_short"
                stackId="dec"
                fill="var(--loss)"
                name="enter short"
              />
              <Bar
                dataKey="exits"
                stackId="dec"
                fill="var(--color-primary)"
                name="exit / move_be"
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function GateRefusalsTimeline({ data }: { data: DailyActivityPoint[] }) {
  const hasData = data.some(
    (d) =>
      d.gate_refusals + d.drift_refusals + d.bar_staleness + d.condition_misses + d.fires > 0
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Engine activity per day</CardTitle>
        <p className="text-xs text-muted-foreground">
          Refusals by type + entry fires. Sustained drift refusals means live price is moving away
          from the bar-close snapshot — investigate broker latency.
        </p>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <EmptyChart message="No scan activity in this window." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar
                dataKey="gate_refusals"
                stackId="ref"
                fill="var(--color-muted-foreground)"
                name="market-state gate"
              />
              <Bar
                dataKey="drift_refusals"
                stackId="ref"
                fill="var(--loss)"
                name="drift refusal"
              />
              <Bar
                dataKey="bar_staleness"
                stackId="ref"
                fill="var(--color-secondary)"
                name="bar staleness"
              />
              <Bar
                dataKey="condition_misses"
                stackId="ref"
                fill="var(--color-accent)"
                name="condition miss"
              />
              <Bar dataKey="fires" fill="var(--profit)" name="entry fires" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function PortfolioEquityCurve({ data }: { data: EquityPoint[] }) {
  const totalTrades = data.length > 0 ? data[data.length - 1].trades_closed : 0;
  const totalPnl = data.length > 0 ? data[data.length - 1].cumulative_pnl : 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span>Portfolio equity (closed paper P&amp;L)</span>
          <span
            className={
              totalPnl >= 0
                ? "text-xs font-mono tabular-nums text-[var(--profit)]"
                : "text-xs font-mono tabular-nums text-[var(--loss)]"
            }
          >
            {fmtCurrency(totalPnl)} · {totalTrades} closes
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Cumulative realized P&amp;L summed across all paper algos over the window. Live algos
          included if they closed during this period.
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyChart message="No closed paper trades in this window." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor={totalPnl >= 0 ? "var(--profit)" : "var(--loss)"}
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="95%"
                    stopColor={totalPnl >= 0 ? "var(--profit)" : "var(--loss)"}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtCurrency} tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v) => fmtCurrency(Number(v))}
              />
              <Area
                type="monotone"
                dataKey="cumulative_pnl"
                stroke={totalPnl >= 0 ? "var(--profit)" : "var(--loss)"}
                strokeWidth={2}
                fill="url(#equityFill)"
                name="Cumulative P&amp;L"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}
