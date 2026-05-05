"use client";

/**
 * Per-algorithm inspector rail — sits in the right column of the
 * algorithm detail page. Three stacked panels:
 *
 *   1. Scan controls (Scan now button, requires status='active')
 *   2. FTMO compliance gauges (existing card, wrapped)
 *   3. Readiness verdict (existing card, wrapped)
 *
 * The existing `FtmoComplianceCard` and `ReadinessCheckCard` use the
 * `Card` primitive internally; nesting them in a `Surface` would
 * double-card. Instead we render them directly — visual reskin to
 * `Surface`-based bodies is a follow-up PR's concern.
 */
import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { useTriggerScan } from "@/hooks/use-paper-trading";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import type { ScanResult } from "@/lib/scan/engine";
import { formatPnl, formatPriceValue, pnlColorClass } from "@/lib/utils/pnl";
import { AlgoActivityPanel } from "./algo-activity-panel";
import { FtmoComplianceCard } from "./ftmo-compliance-card";
import { ReadinessCheckCard } from "./readiness-check-card";

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

function ScanPanel({ algorithmId, isActive }: { algorithmId: string; isActive: boolean }) {
  const scanMutation = useTriggerScan();
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleScan() {
    setResults(null);
    setError(null);
    scanMutation.mutate(algorithmId, {
      onSuccess: (r) => {
        if (r.success) setResults(r.data);
        else setError(r.error);
      },
    });
  }

  return (
    <Surface elevation="low" className="p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Quick actions</p>
      <Button
        onClick={handleScan}
        disabled={scanMutation.isPending || !isActive}
        className="w-full"
        title={!isActive ? "Algorithm must be active to scan" : undefined}
      >
        {scanMutation.isPending ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Scanning…
          </>
        ) : (
          <>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Scan now
          </>
        )}
      </Button>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {results && (
        <div className="mt-3">
          <ScanResultsList results={results} />
        </div>
      )}
    </Surface>
  );
}

export function AlgoInspectorRail({
  algorithmId,
  algorithmStatus,
}: {
  algorithmId: string;
  algorithmStatus: string;
}) {
  return (
    <div className="space-y-4">
      <ScanPanel algorithmId={algorithmId} isActive={algorithmStatus === "active"} />
      <FtmoComplianceCard algorithmId={algorithmId} />
      <ReadinessCheckCard algorithmId={algorithmId} />
      <AlgoActivityPanel algorithmId={algorithmId} />
    </div>
  );
}
