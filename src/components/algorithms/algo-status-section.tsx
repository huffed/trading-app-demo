"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTriggerScan } from "@/hooks/use-paper-trading";
import type { ScanResult } from "@/lib/scan/engine";
import { AlgoSection } from "./algo-section";
import { AlgorithmHealthHeader } from "./algorithm-health-header";
import { FtmoComplianceCard } from "./ftmo-compliance-card";
import { ReadinessCheckCard } from "./readiness-check-card";

function ScanNowButton({
  algorithmId,
  algorithmStatus,
}: {
  algorithmId: string;
  algorithmStatus: string;
}) {
  const scanMutation = useTriggerScan();
  const [scanError, setScanError] = useState<string | null>(null);
  const [, setScanResults] = useState<ScanResult[] | null>(null);
  const isActive = algorithmStatus === "active";

  const handleScan = () => {
    setScanError(null);
    scanMutation.mutate(algorithmId, {
      onSuccess: (r) => {
        if (r.success) setScanResults(r.data);
        else setScanError(r.error);
      },
    });
  };

  return (
    <div className="flex items-center gap-2">
      {scanError && <span className="text-xs text-destructive">{scanError}</span>}
      <Button size="sm" onClick={handleScan} disabled={scanMutation.isPending || !isActive}>
        {scanMutation.isPending ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Scanning...
          </>
        ) : (
          <>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Scan now
          </>
        )}
      </Button>
    </div>
  );
}

/**
 * Status section — always expanded. Answers "is the system OK?" in
 * one viewport. Combines:
 *   - Health header (positions count, today P&L, last scan, halts)
 *   - FTMO compliance summary
 *   - Readiness check verdict
 *   - Scan-now action
 */
export function AlgoStatusSection({
  algorithmId,
  algorithmStatus,
  liveTradingEnabled,
  lastScannedAt,
}: {
  algorithmId: string;
  algorithmStatus: string;
  liveTradingEnabled: boolean;
  lastScannedAt: string | null;
}) {
  return (
    <AlgoSection
      storageKey={`algo:${algorithmId}:section:status`}
      alwaysExpanded
      title="Status"
      action={
        <ScanNowButton algorithmId={algorithmId} algorithmStatus={algorithmStatus} />
      }
    >
      <AlgorithmHealthHeader
        algorithmId={algorithmId}
        algorithmStatus={algorithmStatus}
        liveTradingEnabled={liveTradingEnabled}
        lastScannedAt={lastScannedAt}
      />
      <FtmoComplianceCard algorithmId={algorithmId} />
      <ReadinessCheckCard algorithmId={algorithmId} />
    </AlgoSection>
  );
}
