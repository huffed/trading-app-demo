"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useStrategyStats } from "@/hooks/use-strategy-stats";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";
import type { ConditionStatRow, PairStatRow } from "@/types/strategy-stats";

const SAMPLE_SIZE_THRESHOLD = 3;

function winRateColor(winRatePct: number, trades: number): string {
  if (trades < SAMPLE_SIZE_THRESHOLD) return "text-muted-foreground";
  if (winRatePct >= 60) return "text-[var(--profit)]";
  if (winRatePct <= 40) return "text-[var(--loss)]";
  return "";
}

function PerPairBadges({ row }: { row: ConditionStatRow }) {
  const entries = Object.entries(row.per_pair).sort(
    (a, b) => b[1].trades - a[1].trades
  );
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([ticker, pp]) => {
        const wr = (pp.wins / pp.trades) * 100;
        return (
          <Badge key={ticker} variant="secondary" className="text-[10px] tabular-nums">
            {ticker} {pp.trades}× · {wr.toFixed(0)}% · {formatPnl(pp.pnl_usd)}
          </Badge>
        );
      })}
    </div>
  );
}

function ConditionStatsCard({ rows }: { rows: ConditionStatRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-condition outcomes</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No closed trades with recorded condition signatures yet. Stats appear
            once trades close.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Per-condition outcomes</CardTitle>
        <p className="text-xs text-muted-foreground">
          Win rates &lt; {SAMPLE_SIZE_THRESHOLD} trades show muted — sample too small.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Condition signature</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Avg P&L</TableHead>
              <TableHead className="text-right">Total P&L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.signature}>
                <TableCell>
                  <div className="font-mono text-xs">{row.signature}</div>
                  <PerPairBadges row={row} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.trades}</TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${winRateColor(row.win_rate_pct, row.trades)}`}
                >
                  {row.win_rate_pct.toFixed(1)}%
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${pnlColorClass(row.avg_pnl_usd)}`}
                >
                  {formatPnl(row.avg_pnl_usd)}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${pnlColorClass(row.total_pnl_usd)}`}
                >
                  {formatPnl(row.total_pnl_usd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PairStatsCard({ rows }: { rows: PairStatRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Per-pair outcomes</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Avg P&L</TableHead>
              <TableHead className="text-right">Total P&L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.ticker}>
                <TableCell className="font-medium">{row.ticker}</TableCell>
                <TableCell className="text-right tabular-nums">{row.trades}</TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${winRateColor(row.win_rate_pct, row.trades)}`}
                >
                  {row.win_rate_pct.toFixed(1)}%
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${pnlColorClass(row.avg_pnl_usd)}`}
                >
                  {formatPnl(row.avg_pnl_usd)}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${pnlColorClass(row.total_pnl_usd)}`}
                >
                  {formatPnl(row.total_pnl_usd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function StrategyStatsTab({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useStrategyStats(algorithmId);

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Stats unavailable.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <div className="text-sm">
            <span className="font-medium">{data.total_closed_trades}</span> closed trades
            {data.excluded_trades > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                ({data.excluded_trades} excluded — no condition signature recorded)
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Updates as positions close. Cached 30s.
          </div>
        </CardContent>
      </Card>
      <ConditionStatsCard rows={data.by_signature} />
      <PairStatsCard rows={data.by_pair} />
    </div>
  );
}
