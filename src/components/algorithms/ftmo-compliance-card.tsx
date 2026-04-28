"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Clock, ShieldCheck, ShieldAlert, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useFtmoCompliance } from "@/hooks/use-ftmo-compliance";
import { formatRelativeTime } from "@/lib/utils/pnl";
import type {
  ComplianceGauge,
  DivergenceState,
  HaltEvent,
} from "@/types/ftmo-compliance";

const STATE_BAR: Record<ComplianceGauge["state"], string> = {
  ok: "bg-[var(--profit)]",
  warn: "bg-amber-500",
  breach: "bg-[var(--loss)]",
};
const STATE_LABEL: Record<ComplianceGauge["state"], string> = {
  ok: "OK",
  warn: "Warn",
  breach: "Breach",
};

/**
 * Minutes-until-UTC-midnight countdown. Daily-loss limits and the
 * consecutive-loss soft halt both reset at UTC 00:00 — the operator
 * watching live needs to know whether a yellow gauge will roll over
 * in 30 minutes or whether they have 14 hours left to bleed.
 */
function useMinutesUntilUtcMidnight(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(0, Math.round((next.getTime() - now) / 60_000));
}

function ResetCountdown() {
  const minutes = useMinutesUntilUtcMidnight();
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
      <Clock className="h-3 w-3" />
      Resets in {hours}h {mins.toString().padStart(2, "0")}m
    </span>
  );
}

function GaugeRow({
  gauge,
  profitOriented,
  trailing,
}: {
  gauge: ComplianceGauge;
  profitOriented?: boolean;
  trailing?: React.ReactNode;
}) {
  const filled = Math.min((gauge.value_pct / gauge.threshold_pct) * 100, 100);
  const stateLabel = profitOriented && gauge.state === "breach" ? "Met" : STATE_LABEL[gauge.state];
  const stateClass =
    profitOriented && gauge.state === "breach" ? "bg-[var(--profit)]" : STATE_BAR[gauge.state];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{gauge.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {gauge.value_pct.toFixed(2)}% / {gauge.threshold_pct.toFixed(2)}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-muted">
        <div
          className={`h-full transition-all ${stateClass}`}
          style={{ width: `${filled}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        {trailing ?? <span />}
        <Badge variant="secondary" className="text-[10px]">
          {stateLabel}
        </Badge>
      </div>
    </div>
  );
}

function DivergenceIcon({ d }: { d: DivergenceState }) {
  if (d.is_armed) return <ShieldAlert className="h-3.5 w-3.5 text-[var(--loss)]" />;
  const armed = d.samples >= d.required_samples;
  const cls = armed ? "text-[var(--profit)]" : "text-muted-foreground";
  return <ShieldCheck className={`h-3.5 w-3.5 ${cls}`} />;
}

function DivergenceRow({ d }: { d: DivergenceState }) {
  const armed = d.samples >= d.required_samples;
  return (
    <div className="space-y-1 rounded-md border p-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <DivergenceIcon d={d} />
          Divergence kill switch
        </span>
        <span className="tabular-nums text-muted-foreground">
          {d.samples} / {d.required_samples} samples
        </span>
      </div>
      {armed ? (
        <div className="text-xs text-muted-foreground tabular-nums">
          rolling avg <span className={d.is_armed ? "text-[var(--loss)] font-medium" : ""}>
            {d.avg_bps.toFixed(2)} bps
          </span>{" "}
          / threshold {d.threshold_bps} bps
          {d.is_armed && " — TRIPPED"}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Arms after {d.required_samples} broker-mirrored entries land. Currently
          accumulating.
        </div>
      )}
    </div>
  );
}

function HaltsList({ events }: { events: HaltEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border p-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        Recent halt events
      </div>
      {events.map((e, i) => (
        <div key={i} className="flex items-center justify-between text-xs">
          <span>
            <Badge variant="outline" className="mr-1.5 text-[10px]">
              {e.event_type === "daily_loss_halt" ? "Daily loss" : "Divergence"}
            </Badge>
            <span className="text-muted-foreground">{summariseHalt(e)}</span>
          </span>
          <span className="text-muted-foreground tabular-nums">
            {formatRelativeTime(e.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function summariseHalt(e: HaltEvent): string {
  if (e.event_type === "daily_loss_halt") {
    const pnl = e.details.todays_pnl_pct;
    const thr = e.details.threshold_pct;
    return `${pnl}% vs ${thr}% threshold`;
  }
  if (e.event_type === "divergence_halt") {
    const avg = e.details.avg_bps;
    const thr = e.details.threshold_bps;
    return `avg ${avg} bps vs ${thr} bps threshold`;
  }
  return "";
}

export function FtmoComplianceCard({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useFtmoCompliance(algorithmId);

  if (isLoading) return <Skeleton className="h-44 w-full" />;
  if (!data || !data.has_prop_firm) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-base">
          <Target className="h-4 w-4" />
          FTMO Compliance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {data.daily_pnl && (
            <GaugeRow gauge={data.daily_pnl} trailing={<ResetCountdown />} />
          )}
          {data.drawdown && <GaugeRow gauge={data.drawdown} />}
          {data.profit_target && <GaugeRow gauge={data.profit_target} profitOriented />}
        </div>
        {data.divergence && <DivergenceRow d={data.divergence} />}
        <HaltsList events={data.recent_halts} />
      </CardContent>
    </Card>
  );
}
