"use client";

/**
 * Inspector rail for the dashboard — live ops at a glance, plus the
 * primary action (Scan all). Two stacked `Surface` panels: status
 * snapshot + scan controls.
 */
import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataRow } from "@/components/ui/data-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { usePaperTradingStats, useTriggerScan } from "@/hooks/use-paper-trading";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import type { ScanResult } from "@/lib/scan/engine";
import { formatPnl, formatPriceValue, formatRelativeTime, pnlColorClass } from "@/lib/utils/pnl";

function StatusPanel() {
  const { data, isLoading } = usePaperTradingStats();
  return (
    <Surface elevation="low" className="p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Live status</p>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          <DataRow label="Active algorithms" value={data?.active_algorithms ?? 0} />
          <DataRow
            label="Last scan"
            value={data?.last_scan_at ? formatRelativeTime(data.last_scan_at) : "never"}
          />
          <DataRow
            label="Unrealized"
            value={
              <span className={pnlColorClass(data?.total_unrealized_pnl ?? 0)}>
                {formatPnl(data?.total_unrealized_pnl ?? 0)}
              </span>
            }
          />
          <DataRow
            label="Realized · all-time"
            value={
              <span className={pnlColorClass(data?.total_realized_pnl ?? 0)}>
                {formatPnl(data?.total_realized_pnl ?? 0)}
              </span>
            }
          />
        </div>
      )}
    </Surface>
  );
}

function ScanResultsList({ results }: { results: ScanResult[] }) {
  const opened = results.flatMap((r) => r.opened_details);
  const closed = results.flatMap((r) => r.closed_details);
  if (opened.length === 0 && closed.length === 0) {
    return <p className="text-xs text-muted-foreground">Scan complete — no signals fired.</p>;
  }
  return (
    <div className="space-y-1 text-xs">
      {opened.map((e, i) => (
        <p key={`o-${i}`} className="text-[var(--profit)]">
          ▲ Opened <strong>{e.ticker}</strong> @ {formatPriceValue(e.ticker, e.price)}
        </p>
      ))}
      {closed.map((e, i) => (
        <p key={`c-${i}`}>
          ▼ Closed <strong>{e.ticker}</strong>{" "}
          <span className={pnlColorClass(e.pnl)}>{formatPnl(e.pnl)}</span>{" "}
          <span className="text-muted-foreground">
            ({EXIT_REASON_LABELS[e.reason] ?? e.reason})
          </span>
        </p>
      ))}
    </div>
  );
}

function ScanPanel() {
  const scanMutation = useTriggerScan();
  const [results, setResults] = useState<ScanResult[] | null>(null);

  function handleScan() {
    setResults(null);
    // force=true bypasses the LLM-trader bar-close gate — operator
    // explicitly asked for an evaluation, run it now even mid-bar.
    scanMutation.mutate(
      { force: true },
      {
        onSuccess: (r) => {
          if (r.success) setResults(r.data);
        },
      }
    );
  }

  return (
    <Surface elevation="low" className="p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Quick actions</p>
      <Button onClick={handleScan} disabled={scanMutation.isPending} className="w-full">
        {scanMutation.isPending ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Scanning…
          </>
        ) : (
          <>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Scan all algorithms
          </>
        )}
      </Button>
      {results && <div className="mt-3">{<ScanResultsList results={results} />}</div>}
    </Surface>
  );
}

export function LiveStatusRail() {
  return (
    <div className="space-y-4">
      <StatusPanel />
      <ScanPanel />
    </div>
  );
}
