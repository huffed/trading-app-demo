"use client";

import { useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, Loader2, Play } from "lucide-react";
import { AlgoEquityCurveCard } from "@/components/algorithms/algo-equity-curve-card";
import { AlgorithmHealthHeader } from "@/components/algorithms/algorithm-health-header";
import { NearMissFeed } from "@/components/algorithms/near-miss-feed";
import { ClosedPositionsCard, OpenPositionsCard } from "@/components/algorithms/position-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivityLog, useTriggerScan } from "@/hooks/use-paper-trading";
import { ACTIVITY_TYPE_LABELS, EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import type { ScanResult } from "@/lib/scan/engine";
import {
  formatPnl,
  formatPriceValue,
  formatRelativeTime,
  pnlColorClass,
} from "@/lib/utils/pnl";

function ScanSummary({ results }: { results: ScanResult[] }) {
  if (results.length === 0) {
    return null;
  }

  const totalScanned = results.reduce((s, r) => s + r.tickers_scanned, 0);
  const allOpened = results.flatMap((r) => r.opened_details);
  const allClosed = results.flatMap((r) => r.closed_details);
  const allErrors = results.flatMap((r) => r.errors);
  const noAction = allOpened.length === 0 && allClosed.length === 0;

  return (
    <div className="rounded-lg border bg-muted/50 p-3 text-sm space-y-2">
      <div className="flex items-center gap-1.5 font-medium">
        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--profit)]" />
        Scan complete — {totalScanned} ticker{totalScanned !== 1 ? "s" : ""} checked
      </div>

      {allOpened.map((e, i) => (
        <div key={`o-${i}`} className="flex items-center gap-2 text-[var(--profit)]">
          <span>&#9650;</span>
          <span>
            Opened <strong>{e.ticker}</strong> at {formatPriceValue(e.ticker, e.price)}
          </span>
        </div>
      ))}

      {allClosed.map((e, i) => (
        <div key={`c-${i}`} className="flex items-center gap-2">
          <span className="text-muted-foreground">&#9660;</span>
          <span>
            Closed <strong>{e.ticker}</strong> at {formatPriceValue(e.ticker, e.price)}
            {" — "}
            <span className={pnlColorClass(e.pnl)}>{formatPnl(e.pnl)}</span>
            {" — "}
            <span className="text-muted-foreground">
              {EXIT_REASON_LABELS[e.reason] ?? e.reason}
            </span>
          </span>
        </div>
      ))}

      {noAction && <p className="text-muted-foreground">No signals fired</p>}

      {allErrors.length > 0 && (
        <p className="text-xs text-destructive">
          {allErrors.length} error{allErrors.length !== 1 ? "s" : ""}:{" "}
          {allErrors.map((e) => e.ticker).join(", ")}
        </p>
      )}
    </div>
  );
}

function ScanControls({
  algorithmId,
  algorithmStatus,
  lastScannedAt,
}: {
  algorithmId: string;
  algorithmStatus: string;
  lastScannedAt: string | null;
}) {
  const scanMutation = useTriggerScan();
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResults, setScanResults] = useState<ScanResult[] | null>(null);
  const isActive = algorithmStatus === "active";

  function handleScan() {
    setScanError(null);
    setScanResults(null);
    scanMutation.mutate(algorithmId, {
      onSuccess: (result) => {
        if (!result.success) {
          setScanError(result.error);
        } else {
          setScanResults(result.data);
        }
      },
    });
  }

  return (
    <div className="space-y-2">
      {!isActive && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
          <span>
            Set this algorithm to <strong>Active</strong> to enable scanning.
          </span>
        </div>
      )}
      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Scan Watchlist</p>
            <p className="text-xs text-muted-foreground">
              {lastScannedAt
                ? `Last scanned ${formatRelativeTime(lastScannedAt)}`
                : "Never scanned"}
            </p>
            {scanError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {scanError}
              </p>
            )}
          </div>
          <Button size="sm" onClick={handleScan} disabled={scanMutation.isPending || !isActive}>
            {scanMutation.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Scan Now
              </>
            )}
          </Button>
        </CardContent>
      </Card>
      {scanResults && <ScanSummary results={scanResults} />}
    </div>
  );
}

function ActivityContent({
  entries,
}: {
  entries: { id: string; event_type: string; ticker: string | null; created_at: string }[];
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity yet. Run a scan to get started.</p>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-3 text-sm">
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <span className="font-medium">
              {ACTIVITY_TYPE_LABELS[entry.event_type] ?? entry.event_type}
            </span>
            {entry.ticker && (
              <Badge variant="outline" className="ml-1.5 text-xs">
                {entry.ticker}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatRelativeTime(entry.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function RecentActivity({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useActivityLog({ algorithm_id: algorithmId }, 1, 20);
  const entries = data?.entries ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? <Skeleton className="h-24 w-full" /> : <ActivityContent entries={entries} />}
      </CardContent>
    </Card>
  );
}

export function PaperTradingTab({
  algorithmId,
  algorithmStatus,
  lastScannedAt,
  liveTradingEnabled,
}: {
  algorithmId: string;
  algorithmStatus: string;
  lastScannedAt: string | null;
  liveTradingEnabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <AlgorithmHealthHeader
        algorithmId={algorithmId}
        algorithmStatus={algorithmStatus}
        liveTradingEnabled={liveTradingEnabled}
        lastScannedAt={lastScannedAt}
      />
      <ScanControls
        algorithmId={algorithmId}
        algorithmStatus={algorithmStatus}
        lastScannedAt={lastScannedAt}
      />
      <OpenPositionsCard algorithmId={algorithmId} />
      <AlgoEquityCurveCard algorithmId={algorithmId} />
      <ClosedPositionsCard algorithmId={algorithmId} />
      <NearMissFeed algorithmId={algorithmId} />
      <RecentActivity algorithmId={algorithmId} />
    </div>
  );
}
