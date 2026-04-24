"use client";

import { useState } from "react";
import { Pencil, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { useTradesList, useDeleteTrade } from "@/hooks/use-trades";
import {
  formatPnl,
  formatPnlPercent,
  pnlColorClass,
  formatCurrency,
  formatQuantity,
  calculatePnlPercent,
} from "@/lib/utils/pnl";
import { useTradeFilterStore } from "@/stores/trade-filter-store";
import type { Trade } from "@/types/trade";
import { TradeForm } from "./trade-form";

const PER_PAGE = 25;

interface TradeRowProps {
  trade: Trade;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}

function TradeRowCells({ trade, onEdit, onDelete }: TradeRowProps) {
  const pnlPct = calculatePnlPercent(trade);
  return (
    <TableRow>
      <TableCell className="font-medium">{trade.symbol}</TableCell>
      <TableCell>
        <Badge variant={trade.side === "long" ? "default" : "secondary"} className="text-xs">
          {trade.side === "long" ? "Long" : "Short"}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{formatQuantity(trade.quantity)}</TableCell>
      <TableCell className="text-right">{formatCurrency(trade.entry_price)}</TableCell>
      <TableCell className="text-right">
        {trade.exit_price != null ? formatCurrency(trade.exit_price) : "\u2014"}
      </TableCell>
      <TableCell className={`text-right font-medium ${pnlColorClass(trade.realized_pnl)}`}>
        {formatPnl(trade.realized_pnl)}
      </TableCell>
      <TableCell className={`text-right ${pnlColorClass(pnlPct)}`}>
        {formatPnlPercent(pnlPct)}
      </TableCell>
      <TableCell>
        <Badge variant={trade.status === "open" ? "outline" : "secondary"} className="text-xs">
          {trade.status === "open" ? "Open" : "Closed"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {new Date(trade.entry_date).toLocaleDateString()}
      </TableCell>
      <TableCell className="text-muted-foreground">{trade.strategy ?? "\u2014"}</TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-xs" onClick={() => onEdit(trade)}>
            <Pencil className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => onDelete(trade)}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  setPage: (page: number) => void;
}

function TablePagination({ page, totalPages, total, setPage }: PaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-2 py-3">
      <p className="text-xs text-muted-foreground">
        {total} trade{total !== 1 && "s"}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft className="h-3 w-3" />
        </Button>
        <span className="px-2 text-xs text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

interface TradeDialogsProps {
  editTrade: Trade | null;
  setEditTrade: (trade: Trade | null) => void;
  deleteTarget: Trade | null;
  setDeleteTarget: (trade: Trade | null) => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function TradeDialogs({
  editTrade,
  setEditTrade,
  deleteTarget,
  setDeleteTarget,
  onDelete,
  isDeleting,
}: TradeDialogsProps) {
  return (
    <>
      <Dialog open={!!editTrade} onOpenChange={(open) => !open && setEditTrade(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Trade</DialogTitle>
            <DialogDescription>Update the details of your trade.</DialogDescription>
          </DialogHeader>
          {editTrade && <TradeForm trade={editTrade} onSuccess={() => setEditTrade(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Delete Trade</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.symbol} {deleteTarget?.side} trade? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDelete} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TradeTable() {
  const { filters, page, setPage } = useTradeFilterStore();
  const { data, isLoading } = useTradesList(filters, page, PER_PAGE);
  const deleteTrade = useDeleteTrade();

  const [editTrade, setEditTrade] = useState<Trade | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Trade | null>(null);

  const trades = data?.trades ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  function handleDelete() {
    if (!deleteTarget) return;
    deleteTrade.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">No trades found</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add your first trade or adjust your filters.
        </p>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Entry</TableHead>
            <TableHead className="text-right">Exit</TableHead>
            <TableHead className="text-right">P&L</TableHead>
            <TableHead className="text-right">P&L %</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Strategy</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((trade) => (
            <TradeRowCells
              key={trade.id}
              trade={trade}
              onEdit={setEditTrade}
              onDelete={setDeleteTarget}
            />
          ))}
        </TableBody>
      </Table>
      <TablePagination page={page} totalPages={totalPages} total={total} setPage={setPage} />
      <TradeDialogs
        editTrade={editTrade}
        setEditTrade={setEditTrade}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        onDelete={handleDelete}
        isDeleting={deleteTrade.isPending}
      />
    </>
  );
}
