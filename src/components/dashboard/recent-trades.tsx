"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradesList } from "@/hooks/use-trades";
import { formatDate } from "@/lib/utils/date";
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
          {formatDate(trade.entry_date)}
        </span>
        <span className={`text-sm font-medium ${pnlColorClass(trade.realized_pnl)}`}>
          {formatPnl(trade.realized_pnl)}
        </span>
      </div>
    </div>
  );
}

const EMPTY = (
  <EmptyState
    title="No trades yet"
    action={{ href: "/trades", label: "Add your first trade", variant: "outline" }}
    className="py-8"
  />
);

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
        {!isLoading && trades.length === 0 && EMPTY}
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
