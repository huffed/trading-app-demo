"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useOpenPositions,
  useClosedPositions,
  useClosePosition,
  useAutoRefreshPrices,
} from "@/hooks/use-paper-trading";
import { EXIT_REASON_LABELS } from "@/lib/constants/algorithm";
import { getQuantityUnitFor } from "@/lib/constants/markets";
import { formatPriceValue, formatQuantity } from "@/lib/utils/pnl";
import type { PaperPosition } from "@/types/position";
import { BrokerErrorBanner, BrokerErrorIcon } from "./broker-error-indicators";
import { PnlCell } from "./position-pnl-cell";
import { PriceCellWithBroker } from "./position-price-cell";

function PositionRow({
  pos,
  onClose,
}: {
  pos: PaperPosition;
  onClose: (pos: PaperPosition) => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{pos.ticker}</span>
          {pos.broker_error && <BrokerErrorIcon message={pos.broker_error} />}
          <span className="ml-1.5 text-xs text-muted-foreground">
            {formatQuantity(pos.quantity)} {getQuantityUnitFor(pos.ticker, pos.quantity)}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <PriceCellWithBroker
          symbol={pos.ticker}
          paperPrice={pos.entry_price}
          brokerPrice={pos.broker_fill_price}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatPriceValue(pos.ticker, pos.current_price)}
      </TableCell>
      <TableCell className="text-right">
        <PnlCell pos={pos} />
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
        {formatPriceValue(pos.ticker, pos.stop_loss_price)} /{" "}
        {formatPriceValue(pos.ticker, pos.take_profit_price)}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={() => onClose(pos)}>
          Close
        </Button>
      </TableCell>
    </TableRow>
  );
}

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

export function OpenPositionsCard({ algorithmId }: { algorithmId: string }) {
  const { data: positions, isLoading } = useOpenPositions(algorithmId);
  const closeMutation = useClosePosition();
  const [closeTarget, setCloseTarget] = useState<PaperPosition | null>(null);
  const hasPositions = !!positions && positions.length > 0;
  useAutoRefreshPrices(algorithmId, hasPositions);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No open positions. Run a scan to evaluate entry conditions.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <BrokerErrorBanner positions={positions} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open Positions ({positions.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticker</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="text-right">SL / TP</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((pos) => (
                <PositionRow key={pos.id} pos={pos} onClose={setCloseTarget} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticker</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Exit</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow key={pos.id}>
            <TableCell className="font-medium">{pos.ticker}</TableCell>
            <TableCell className="text-right tabular-nums">
              <PriceCellWithBroker
                symbol={pos.ticker}
                paperPrice={pos.entry_price}
                brokerPrice={pos.broker_fill_price}
              />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <PriceCellWithBroker
                symbol={pos.ticker}
                paperPrice={pos.exit_price}
                brokerPrice={pos.broker_close_price}
              />
            </TableCell>
            <TableCell className="text-right">
              <PnlCell pos={pos} />
            </TableCell>
            <TableCell>
              <Badge variant="secondary" className="text-xs">
                {EXIT_REASON_LABELS[pos.exit_reason ?? ""] ?? pos.exit_reason}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
        <span>Closed Positions ({total})</span>
        <ChevronDown className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Closed Positions ({total})</CardTitle>
        <Button size="icon-sm" variant="ghost" onClick={() => setExpanded(false)}>
          <ChevronUp className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <ClosedPositionContent positions={positions} isLoading={isLoading} />
      </CardContent>
    </Card>
  );
}
