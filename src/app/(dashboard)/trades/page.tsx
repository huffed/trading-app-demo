"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { TradeFilters } from "@/components/trades/trade-filters";
import { TradeForm } from "@/components/trades/trade-form";
import { TradeTable } from "@/components/trades/trade-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export default function TradesPage() {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
          <p className="text-sm text-muted-foreground">
            Manage your trade history.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/trades/import" />}
            nativeButton={false}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import CSV
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Trade
          </Button>
        </div>
      </div>

      <TradeFilters />
      <TradeTable />

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Trade</DialogTitle>
            <DialogDescription>
              Manually log a new trade.
            </DialogDescription>
          </DialogHeader>
          <TradeForm onSuccess={() => setShowAdd(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
