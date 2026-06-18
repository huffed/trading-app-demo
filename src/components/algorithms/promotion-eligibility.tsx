"use client";

/**
 * Promotion-to-live eligibility card. Reads gate verdicts written by
 * scripts/step7-backfill-gates.ts (cumulative results from STEP 2
 * friction / STEP 3 walk-forward / STEP 6 OOS holdback per roadmap
 * 2026-06).
 *
 * READ-ONLY in this PR. The actual Promote button + server action ship
 * in STEP 7.4 once paper-mirror milestone tracking is wired.
 */
import { useMemo } from "react";
import { CheckCircle2, XCircle, Clock, AlertCircle, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Algorithm } from "@/types/algorithm";

interface PromotionGateResults {
  computed_at?: string;
  sample_first?: string | null;
  sample_last?: string | null;
  friction?: { slippage_bps: number; spread_bps: number; commission_per_lot: number };
  step2?: {
    total_return: number;
    total_trades: number;
    win_rate: number;
    max_drawdown: number;
    max_static_dd: number;
    max_daily_dd: number;
    verdict: "PASS" | "FAIL" | "EXCLUDED";
    reason?: string;
  };
  step3?: {
    walk_forward_green_pct: number;
    walk_forward_n_windows: number;
    per_year_green_pct: number;
    per_year_n_years: number;
    verdict: "PASS" | "WEAK" | "FAIL" | "INSUFFICIENT_DATA";
    reason: string;
  };
  step6?: {
    in_sample_n: number;
    in_sample_mean_r: number;
    held_out_n: number;
    held_out_mean_r: number;
    r_delta_pct: number;
    verdict: "TIER_1_PASS" | "TIER_2_PASS" | "FAIL" | "INSUFFICIENT_DATA";
    reason: string;
  };
  promotion_eligible?: boolean;
  promotion_blockers?: string[];
}

interface Props {
  algo: Pick<Algorithm, "id" | "name" | "backtest_results" | "live_trading_enabled" | "broker_connection_id">;
}

function VerdictIcon({ verdict }: { verdict: string }) {
  if (verdict === "PASS" || verdict === "TIER_1_PASS") return <CheckCircle2 className="h-4 w-4 text-[color:var(--profit)]" />;
  if (verdict === "TIER_2_PASS" || verdict === "WEAK") return <AlertCircle className="h-4 w-4 text-amber-500" />;
  if (verdict === "INSUFFICIENT_DATA" || verdict === "EXCLUDED") return <Clock className="h-4 w-4 text-muted-foreground" />;
  return <XCircle className="h-4 w-4 text-[color:var(--loss)]" />;
}

function verdictLabel(verdict?: string): string {
  if (!verdict) return "Not computed";
  if (verdict === "TIER_1_PASS") return "Pass (high confidence)";
  if (verdict === "TIER_2_PASS") return "Pass (small-N caveat)";
  if (verdict === "INSUFFICIENT_DATA") return "Insufficient data";
  return verdict.charAt(0) + verdict.slice(1).toLowerCase();
}

export function PromotionEligibility({ algo }: Props) {
  const gates = (algo.backtest_results ?? null) as PromotionGateResults | null;

  const overall = useMemo(() => {
    if (algo.live_trading_enabled) return { label: "Live", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
    if (!gates || gates.promotion_eligible === undefined) return { label: "Not validated", color: "bg-muted text-muted-foreground" };
    if (gates.promotion_eligible) return { label: "Eligible (awaiting paper milestone)", color: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
    return { label: "Blocked", color: "bg-destructive/15 text-destructive border-destructive/30" };
  }, [algo.live_trading_enabled, gates]);

  if (!gates) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" /> Promotion eligibility
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            No validation results stored. Run <code className="font-mono text-xs">scripts/step7-backfill-gates.ts</code> to populate.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Promotion eligibility
          </span>
          <Badge variant="outline" className={cn("text-xs", overall.color)}>
            {overall.label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* STEP 2 Friction */}
        <div className="flex items-start gap-2 rounded-md border border-glass-border p-3">
          <VerdictIcon verdict={gates.step2?.verdict ?? ""} />
          <div className="flex-1">
            <div className="text-sm font-medium">STEP 2 — Realistic friction gate</div>
            {gates.step2 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                ${gates.step2.total_return.toFixed(0)} · {gates.step2.total_trades} trades · WR {gates.step2.win_rate}% · static DD {gates.step2.max_static_dd}% · daily DD {gates.step2.max_daily_dd}%
                {gates.step2.reason && <div className="mt-1 text-amber-500">{gates.step2.reason}</div>}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Not computed</div>
            )}
          </div>
          <Badge variant="outline" className="text-xs">{verdictLabel(gates.step2?.verdict)}</Badge>
        </div>

        {/* STEP 3 Walk-forward */}
        <div className="flex items-start gap-2 rounded-md border border-glass-border p-3">
          <VerdictIcon verdict={gates.step3?.verdict ?? ""} />
          <div className="flex-1">
            <div className="text-sm font-medium">STEP 3 — Walk-forward + per-year robustness</div>
            {gates.step3 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                WF {gates.step3.walk_forward_green_pct}% green ({gates.step3.walk_forward_n_windows} windows) · per-year {gates.step3.per_year_green_pct}% green ({gates.step3.per_year_n_years} years)
                {gates.step3.reason && <div className="mt-1 text-muted-foreground/80">{gates.step3.reason}</div>}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Not computed</div>
            )}
          </div>
          <Badge variant="outline" className="text-xs">{verdictLabel(gates.step3?.verdict)}</Badge>
        </div>

        {/* STEP 6 OOS holdback */}
        <div className="flex items-start gap-2 rounded-md border border-glass-border p-3">
          <VerdictIcon verdict={gates.step6?.verdict ?? ""} />
          <div className="flex-1">
            <div className="text-sm font-medium">STEP 6 — Out-of-sample holdback</div>
            {gates.step6 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                In-sample R={gates.step6.in_sample_mean_r} (n={gates.step6.in_sample_n}) · held-out R={gates.step6.held_out_mean_r} (n={gates.step6.held_out_n}) · delta {gates.step6.r_delta_pct >= 0 ? "+" : ""}{gates.step6.r_delta_pct}%
                {gates.step6.reason && <div className="mt-1 text-muted-foreground/80">{gates.step6.reason}</div>}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Not computed</div>
            )}
          </div>
          <Badge variant="outline" className="text-xs">{verdictLabel(gates.step6?.verdict)}</Badge>
        </div>

        {/* Broker DEMO alignment — replaces paper-mirror milestone per 2026-06-18 reshape */}
        <div className="flex items-start gap-2 rounded-md border border-glass-border border-dashed p-3 opacity-70">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1">
            <div className="text-sm font-medium">Broker DEMO alignment</div>
            <div className="mt-1 text-xs text-muted-foreground">
              ≥10 broker DEMO trades within ±30% of backtest expected R. Live tracking ships after Phase B (backtest fidelity) completes.
            </div>
          </div>
          <Badge variant="outline" className="text-xs">Pending</Badge>
        </div>

        {/* Blockers */}
        {gates.promotion_blockers && gates.promotion_blockers.length > 0 && (
          <div className="rounded-md bg-destructive/5 p-3 text-xs">
            <div className="mb-1 font-medium text-destructive">Promotion blockers</div>
            <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
              {gates.promotion_blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        {gates.computed_at && (
          <div className="text-right text-xs text-muted-foreground">
            Gates computed {new Date(gates.computed_at).toISOString().slice(0, 10)}. Re-run to refresh.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
