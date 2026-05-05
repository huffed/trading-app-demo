"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import {
  useAutoRefreshPrices,
  useClosePosition,
  useClosedPositions,
  useOpenPositions,
} from "@/hooks/use-paper-trading";
import type { PaperPosition } from "@/types/position";
import { BrokerErrorBanner } from "./broker-error-indicators";
import { PositionDetailCard } from "./position-detail-card";

function CloseDialog({
  target,
  onClose,
  isPending,
  onConfirm,
}: {
  target: PaperPosition | null;
  onClose: () => void;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Close Position</DialogTitle>
          <DialogDescription>Close {target?.ticker} at current market price?</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={isPending} onClick={onConfirm}>
            {isPending ? "Closing..." : "Close Position"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OpenHeader({ count }: { count: number }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Open positions</p>
      {count > 0 && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </div>
  );
}

export function OpenPositionsCard({ algorithmId }: { algorithmId: string }) {
  const { data: positions, isLoading } = useOpenPositions(algorithmId);
  const closeMutation = useClosePosition();
  const [closeTarget, setCloseTarget] = useState<PaperPosition | null>(null);
  const hasPositions = !!positions && positions.length > 0;
  useAutoRefreshPrices(algorithmId, hasPositions);

  if (isLoading) {
    return (
      <Surface elevation="mid" className="p-5">
        <OpenHeader count={0} />
        <Skeleton className="h-24 w-full" />
      </Surface>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <Surface elevation="mid" className="p-5">
        <OpenHeader count={0} />
        <p className="py-6 text-center text-sm text-muted-foreground">
          No open positions. Run a scan to evaluate entry conditions.
        </p>
      </Surface>
    );
  }

  return (
    <>
      <BrokerErrorBanner positions={positions} />
      <Surface elevation="mid" className="p-5">
        <OpenHeader count={positions.length} />
        <div className="-mx-5">
          {positions.map((pos) => (
            <PositionDetailCard key={pos.id} pos={pos} onClose={setCloseTarget} />
          ))}
        </div>
      </Surface>
      <CloseDialog
        target={closeTarget}
        onClose={() => setCloseTarget(null)}
        isPending={closeMutation.isPending}
        onConfirm={() => {
          if (!closeTarget) {
            return;
          }
          closeMutation.mutate(closeTarget.id, {
            onSuccess: (r) => {
              if (r.success) {
                setCloseTarget(null);
              }
            },
          });
        }}
      />
    </>
  );
}

function ClosedPositionContent({
  positions,
  isLoading,
}: {
  positions: PaperPosition[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (positions.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No closed positions yet.</p>;
  }
  return (
    <div>
      {positions.map((pos) => (
        <PositionDetailCard key={pos.id} pos={pos} />
      ))}
    </div>
  );
}

export function ClosedPositionsCard({ algorithmId }: { algorithmId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useClosedPositions(algorithmId, 1, 10);
  const positions = data?.positions ?? [];
  const total = data?.total ?? 0;

  if (!expanded) {
    return (
      <Button
        variant="ghost"
        className="w-full justify-between text-muted-foreground"
        onClick={() => setExpanded(true)}
      >
        <span>Closed positions ({total})</span>
        <ChevronDown className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Surface elevation="mid" className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Closed positions
        </p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{total}</span>
          <Button size="icon-sm" variant="ghost" onClick={() => setExpanded(false)}>
            <ChevronUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="-mx-5">
        <ClosedPositionContent positions={positions} isLoading={isLoading} />
      </div>
    </Surface>
  );
}
