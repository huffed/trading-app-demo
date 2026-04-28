"use client";

import { AlertTriangle } from "lucide-react";
import type { PaperPosition } from "@/types/position";

export function BrokerErrorIcon({ message }: { message: string }) {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded text-[var(--loss)]"
      title={`Broker error: ${message}`}
      aria-label={`Broker error: ${message}`}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Banner above the open-positions table summarising every position whose
 * broker mirror failed (broker_error column populated). Lets the operator
 * spot live-execution rejections without grepping the activity log.
 */
export function BrokerErrorBanner({ positions }: { positions: PaperPosition[] }) {
  const errored = positions.filter((p) => p.broker_error);
  if (errored.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--loss)]/30 bg-[var(--loss)]/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-[var(--loss)]">
        <AlertTriangle className="h-4 w-4" />
        Broker mirror failed on {errored.length} position{errored.length === 1 ? "" : "s"}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
        {errored.map((p) => (
          <li key={p.id} className="flex gap-2">
            <span className="font-mono">{p.ticker}</span>
            <span className="truncate">{p.broker_error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
