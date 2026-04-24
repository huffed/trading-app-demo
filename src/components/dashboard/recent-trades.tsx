"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradesList } from "@/hooks/use-trades";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

function TradeRow({
  trade,
}: {
  trade: { symbol: string; side: string; entry_date: string; realized_pnl: number | null };
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{trade.symbol}</span>
        <Badge variant={trade.side === "long" ? "default" : "secondary"} className="text-xs">
          {trade.side === "long" ? "Long" : "Short"}
        </Badge>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {new Date(trade.entry_date).toLocaleDateString()}
        </span>
        <span className={`text-sm font-medium ${pnlColorClass(trade.realized_pnl)}`}>
          {formatPnl(trade.realized_pnl)}
        </span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <p className="text-sm text-muted-foreground">No trades yet</p>
      <Button
        className="mt-3"
        variant="outline"
        size="sm"
        render={<Link href="/trades" />}
        nativeButton={false}
      >
        Add your first trade
      </Button>
    </div>
  );
}

export function RecentTrades() {
  const { data, isLoading } = useTradesList({}, 1, 7);
  const trades = data?.trades ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Recent Trades</CardTitle>
        {trades.length > 0 && (
          <Button variant="ghost" size="sm" render={<Link href="/trades" />} nativeButton={false}>
            View all
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        {!isLoading && trades.length === 0 && <EmptyState />}
        {!isLoading && trades.length > 0 && (
          <div className="divide-y divide-border">
            {trades.map((trade) => (
              <TradeRow key={trade.id} trade={trade} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
