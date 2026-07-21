"use client";

import { AlertCircle, Clock, Crosshair, Target, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useM1Evidence } from "@/hooks/use-m1-evidence";
import type { M1Evidence, M1TradeRow } from "@/lib/cohort/m1-evidence";
import { formatRelativeTime, pnlColorClass } from "@/lib/utils/pnl";

function fmtR(r: number | null): string {
  return r === null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
}

function fmtPct(v: number | null, dp = 1): string {
  return v === null ? "—" : `${v.toFixed(dp)}%`;
}

export function M1Tab() {
  const { data, isLoading, isError, error } = useM1Evidence();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        MILESTONE M1 &ldquo;First Proven Stream&rdquo; (G.8 gate): <strong>30 closed paper
        trades</strong> with cumulative mean per-trade R within <strong>±30%</strong> of the
        fidelity-corrected backtest baseline. Paper-only interim — this certifies the
        config/pipeline (rules fire, live data path, no drift), not real fill quality. R is
        anchored on the write-once initial SL, so BE moves and uniform risk rescales don&apos;t
        distort it.
      </p>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load M1 evidence</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryRow data={data} />
          <PerAlgoTable data={data} />
          <TradesTable data={data} />
          <p className="text-xs text-muted-foreground">
            Baseline: sibling-aware portfolio mean R {data.baseline_mean_r.toFixed(4)} (WR{" "}
            {data.baseline_wr_pct.toFixed(1)}%, n={843}) from the pinned-corpus
            complete-fidelity harness. Clock start {new Date(data.clock_start).toLocaleDateString()}
            {data.excluded_rows > 0 &&
              ` · ${data.excluded_rows} broken row(s) excluded from the mean`}
            . Per-algo baselines are SOLO runs — the gate applies to the portfolio row only.
          </p>
        </>
      )}
    </div>
  );
}

function statusMetaFor(data: M1Evidence): {
  label: string;
  variant: "default" | "secondary" | "destructive";
} {
  if (data.status === "no_trades") return { label: "No trades yet", variant: "secondary" };
  if (data.status === "accruing") {
    if (data.in_band) return { label: "Accruing — in band", variant: "default" };
    return { label: "Accruing — outside band", variant: "destructive" };
  }
  if (data.in_band) return { label: "GATE REACHED — PASS band", variant: "default" };
  return { label: "GATE REACHED — outside band", variant: "destructive" };
}

function statusHintFor(data: M1Evidence): string {
  if (data.status === "no_trades") {
    return "Awaiting first paper trade (ATR gate selective by design)";
  }
  if (data.status === "accruing") return "Band check is informational until 30 trades";
  if (data.in_band) return "PASS → Stage 5.3 challenge-readiness";
  return "FAIL → retire/recompose per prereg";
}

function SummaryRow({ data }: { data: M1Evidence }) {
  const statusMeta = statusMetaFor(data);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className={data.status !== "no_trades" ? "border-primary/50" : undefined}>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            Progress to gate
          </div>
          <p className="text-2xl font-semibold">
            {data.closed_trades}/{data.gate.min_trades}
          </p>
          <p className="text-xs text-muted-foreground">
            closed trades · {data.open_positions} open
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            Realized mean R
          </div>
          <p className={`text-2xl font-semibold ${pnlColorClass(data.realized_mean_r)}`}>
            {fmtR(data.realized_mean_r)}
          </p>
          <p className="text-xs text-muted-foreground">
            WR {fmtPct(data.realized_win_rate_pct)} vs baseline{" "}
            {fmtPct(data.baseline_wr_pct)}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Crosshair className="h-3.5 w-3.5" />
            Baseline / PASS band
          </div>
          <p className="text-2xl font-semibold">{fmtR(data.baseline_mean_r)}</p>
          <p className="text-xs text-muted-foreground">
            band {data.band.lower_r.toFixed(2)}–{data.band.upper_r.toFixed(2)}R
            {data.tracking_ratio !== null &&
              ` · tracking ${(data.tracking_ratio * 100).toFixed(0)}%`}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            Status
          </div>
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          <p className="text-xs text-muted-foreground">{statusHintFor(data)}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function PerAlgoTable({ data }: { data: M1Evidence }) {
  if (data.per_algo.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No active algorithms found.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Algorithm</th>
              <th className="px-4 py-2 font-medium text-right">Closed</th>
              <th className="px-4 py-2 font-medium text-right">Open</th>
              <th className="px-4 py-2 font-medium text-right">Mean R</th>
              <th className="px-4 py-2 font-medium text-right">WR</th>
              <th className="px-4 py-2 font-medium text-right">Baseline R</th>
              <th className="px-4 py-2 font-medium text-right">Baseline WR</th>
            </tr>
          </thead>
          <tbody>
            {data.per_algo.map((a) => (
              <tr key={a.algorithm_id} className="border-b last:border-0">
                <td className="px-4 py-2 max-w-[280px] truncate" title={a.algorithm_name}>
                  {a.algorithm_name.replace(/^Deploy: /, "")}
                  {a.baseline === null && (
                    <span className="ml-2 text-xs text-muted-foreground">(no baseline)</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{a.closed_trades}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.open_positions}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${pnlColorClass(a.mean_r)}`}>
                  {fmtR(a.mean_r)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtPct(a.win_rate_pct)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                  {a.baseline ? fmtR(a.baseline.mean_r) : "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                  {a.baseline ? fmtPct(a.baseline.wr_pct) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function TradesTable({ data }: { data: M1Evidence }) {
  if (data.trades.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No paper positions since the evidence clock started. The scan is live and gate
          refusals are visible in the Engine activity tab — zero trades in a low-volatility
          stretch is expected behaviour, not silence.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Opened</th>
              <th className="px-4 py-2 font-medium">Algorithm</th>
              <th className="px-4 py-2 font-medium">Side</th>
              <th className="px-4 py-2 font-medium text-right">R</th>
              <th className="px-4 py-2 font-medium text-right">Risk %</th>
              <th className="px-4 py-2 font-medium">Exit</th>
            </tr>
          </thead>
          <tbody>
            {data.trades.map((t: M1TradeRow) => (
              <tr key={t.position_id} className="border-b last:border-0">
                <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                  {formatRelativeTime(t.opened_at)}
                </td>
                <td className="px-4 py-2 max-w-[240px] truncate" title={t.algorithm_name}>
                  {t.algorithm_name.replace(/^Deploy: /, "")}
                </td>
                <td className="px-4 py-2 capitalize">{t.side}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${pnlColorClass(t.r_multiple)}`}>
                  {t.status === "open" ? "open" : fmtR(t.r_multiple)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {t.risk_pct_at_entry === null ? "—" : t.risk_pct_at_entry.toFixed(2)}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{t.exit_reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
