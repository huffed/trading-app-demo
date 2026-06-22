"use client";

import { AlertCircle, AlertTriangle, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCohortReport } from "@/hooks/use-cohort-report";
import type {
  CohortDimensionReport,
  DecayFlag,
  ShadowGateCandidate,
} from "@/lib/cohort/cohort-report";

/**
 * Cohort attribution surface — SG.6 closure (2026-06-22 NIGHT LATE).
 *
 * Surfaces the same aggregation the weekly CLI cron writes to dated
 * JSON files (`scripts/cohort-report-YYYY-MM-DD.json`) but in real-
 * time + filterable. Three operator-facing sections:
 *
 *  1. Decay flags — cohorts whose mean R dropped ≥ 0.5R OR WR dropped
 *     ≥ 20pp in the most recent half-window vs the prior half-window.
 *     ACTIONABLE: cohort needs investigation; consider tightening
 *     entry conditions or extending the observation window.
 *
 *  2. Shadow-gate candidates — cohorts with n ≥ 8 and mean R ≤ −0.3.
 *     PROPOSED log-only gates scoped per algo+prompt_version. Only
 *     flip to enforcing after weeks of shadow evidence (cohort gates
 *     were reverted once for being calibrated on a single window).
 *
 *  3. Per-dimension cohort expectancy — full table per dimension
 *     (regime, prompt_version, side, confidence, session, entry_zone,
 *     exit_reason). Operator review surface for "where's the edge?"
 *
 * Honesty contract: empty data renders "0 trades — awaiting deploy"
 * cleanly. Cohort gates were reverted in 2026 (#136/#137) for being
 * calibrated on a single window — this tab is the cadence that
 * prevents that class of mistake, not a license to repeat it.
 */
export function CohortTab() {
  const { data, isLoading, isError, error } = useCohortReport();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Per-cohort expectancy + decay flags + shadow-gate candidates from{" "}
        <code>llm_decisions</code> joined with <code>paper_positions.entry_reason</code>{" "}
        attribution. SG.6 closure: surfaces the same data the weekly cron writes to{" "}
        <code>scripts/cohort-report-YYYY-MM-DD.json</code> — review here in real time, diff
        the dated JSON files for historical context. Cohort gates were reverted once for being
        calibrated on a single window — shadow-gate candidates below are PROPOSED
        log-only gates, never auto-enforced.
      </p>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load cohort report</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryCards
            total_trades={data.total_trades}
            tagged={data.trades_with_zone_tags}
            skipped={data.trades_skipped_no_r}
            decay_count={data.decay_flags.length}
            shadow_count={data.shadow_gate_candidates.length}
            days={data.days}
            min_n={data.min_n}
          />

          {data.total_trades === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                0 completed cohort trades yet. Expected while live-paper data accumulates —
                cohort attribution requires both an{" "}
                <code>llm_decisions</code> row AND a closed{" "}
                <code>paper_positions</code> row with{" "}
                <code>trade_outcome.r_multiple</code> backfilled by the manage cron.
              </CardContent>
            </Card>
          ) : (
            <>
              <DecayFlagsCard flags={data.decay_flags} days={data.days} min_n={data.min_n} />
              <ShadowGateCard candidates={data.shadow_gate_candidates} />
              <DimensionsCard dimensions={data.dimensions} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCards({
  total_trades,
  tagged,
  skipped,
  decay_count,
  shadow_count,
  days,
  min_n,
}: {
  total_trades: number;
  tagged: number;
  skipped: number;
  decay_count: number;
  shadow_count: number;
  days: number;
  min_n: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="Trades in cohort" value={total_trades.toString()}>
        <p className="text-xs text-muted-foreground">
          {tagged} tagged · {skipped} skipped (no r_multiple)
        </p>
      </SummaryCard>
      <SummaryCard label="Decay flags" value={decay_count.toString()}>
        <p className="text-xs text-muted-foreground">
          last {days}d vs prior {days}d · n≥{min_n}
        </p>
      </SummaryCard>
      <SummaryCard label="Shadow-gate candidates" value={shadow_count.toString()}>
        <p className="text-xs text-muted-foreground">all-time n≥8 · meanR ≤ −0.3</p>
      </SummaryCard>
      <SummaryCard label="Half-window length" value={`${days}d`}>
        <p className="text-xs text-muted-foreground">DAYS env on the CLI cron</p>
      </SummaryCard>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}

function DecayFlagsCard({
  flags,
  days,
  min_n,
}: {
  flags: DecayFlag[];
  days: number;
  min_n: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Decay flags
          <Badge variant="outline" className="ml-auto">
            {flags.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {flags.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No decay flagged (last {days}d vs prior {days}d, n≥{min_n} both halves).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">Cohort</th>
                  <th className="py-2 pr-3">Prior meanR</th>
                  <th className="py-2 pr-3">Recent meanR</th>
                  <th className="py-2 pr-3">Δ meanR</th>
                  <th className="py-2 pr-3">Prior WR</th>
                  <th className="py-2 pr-3">Recent WR</th>
                  <th className="py-2 pr-3">Δ WR pp</th>
                  <th className="py-2 pr-3">n (prior→recent)</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f, i) => (
                  <tr key={i} className="border-b last:border-0 tabular-nums">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{f.dimension}=</span>
                      {f.value}
                    </td>
                    <td className="py-2 pr-3">{f.prior_mean_r.toFixed(2)}</td>
                    <td className="py-2 pr-3">{f.recent_mean_r.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-loss">−{f.mean_drop.toFixed(2)}</td>
                    <td className="py-2 pr-3">{f.prior_wr_pct.toFixed(0)}%</td>
                    <td className="py-2 pr-3">{f.recent_wr_pct.toFixed(0)}%</td>
                    <td className="py-2 pr-3 text-loss">−{f.wr_drop_pp.toFixed(0)}pp</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {f.prior_n}→{f.recent_n}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ShadowGateCard({ candidates }: { candidates: ShadowGateCandidate[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-orange-500" />
          Shadow-gate candidates
          <Badge variant="outline" className="ml-auto">
            {candidates.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No candidates at current n — keep accumulating.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {candidates.map((c, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="text-muted-foreground tabular-nums shrink-0">
                  n={c.n} · meanR {c.mean_r.toFixed(2)}
                </span>
                <span>
                  <span className="font-medium">
                    {c.dimension}={c.value}
                  </span>
                  <span className="text-muted-foreground"> → log-only gate scoped per algo+prompt_version; enforce only after shadow evidence</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DimensionsCard({ dimensions }: { dimensions: CohortDimensionReport[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">All-time cohort expectancy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {dimensions.map((dim) => (
          <div key={dim.label}>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              {dim.label}
            </h3>
            {dim.buckets.length === 0 ? (
              <p className="text-xs text-muted-foreground">no data</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3">Value</th>
                      <th className="py-2 pr-3">n</th>
                      <th className="py-2 pr-3">WR</th>
                      <th className="py-2 pr-3">meanR</th>
                      <th className="py-2 pr-3">sumR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dim.buckets.map((b) => (
                      <tr key={b.value} className="border-b last:border-0 tabular-nums">
                        <td className="py-2 pr-3 font-medium">{b.value}</td>
                        <td className="py-2 pr-3">{b.stats.n}</td>
                        <td className="py-2 pr-3">{b.stats.win_rate_pct.toFixed(0)}%</td>
                        <td className="py-2 pr-3">{b.stats.mean_r.toFixed(2)}</td>
                        <td className="py-2 pr-3">{b.stats.sum_r.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
