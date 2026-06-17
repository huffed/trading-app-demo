"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  MatrixLiveStatus,
  StrategyMatrixRow,
} from "@/lib/performance/strategy-matrix";

type SortKey =
  | "strategy_name"
  | "ticker"
  | "timeframe"
  | "total_return"
  | "expected_annual_dollars"
  | "expected_r_per_trade"
  | "max_drawdown"
  | "total_trades"
  | "status";

const STATUS_BADGE: Record<
  MatrixLiveStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  LIVE: { label: "LIVE", variant: "default" },
  paper: { label: "Paper", variant: "secondary" },
  paused: { label: "Paused", variant: "outline" },
  archived: { label: "Archived", variant: "outline" },
  draft: { label: "Draft", variant: "outline" },
};

function fmtCurrency(value: number | null): string {
  if (value == null) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPercent(value: number | null): string {
  if (value == null) return "—";
  return `${value.toFixed(2)}%`;
}

function fmtR(value: number | null): string {
  if (value == null) return "—";
  return value.toFixed(2);
}

function nullishNum(v: number | null | undefined): number {
  return v == null ? Number.NEGATIVE_INFINITY : v;
}

function compare(a: StrategyMatrixRow, b: StrategyMatrixRow, key: SortKey, dir: 1 | -1): number {
  switch (key) {
    case "strategy_name":
      return (a.strategy_name ?? "").localeCompare(b.strategy_name ?? "") * dir;
    case "ticker":
      return (a.ticker ?? "").localeCompare(b.ticker ?? "") * dir;
    case "timeframe":
      return (a.timeframe ?? "").localeCompare(b.timeframe ?? "") * dir;
    case "status":
      return a.status.localeCompare(b.status) * dir;
    case "total_return":
    case "expected_annual_dollars":
    case "expected_r_per_trade":
    case "max_drawdown":
    case "total_trades":
      return (nullishNum(a[key]) - nullishNum(b[key])) * dir;
  }
}

function SortIndicator({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
  return dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

function HeaderCell({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  align = "left",
  title,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <th
      className={`p-2.5 font-medium text-${align} cursor-pointer hover:text-foreground transition-colors`}
      onClick={() => onSort(sortKey)}
      title={title}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <SortIndicator active={currentKey === sortKey} dir={dir} />
      </span>
    </th>
  );
}

interface ColumnDef {
  label: string;
  key: SortKey;
  align?: "left" | "right";
  title?: string;
}

const COLUMNS: ColumnDef[] = [
  { label: "Strategy", key: "strategy_name" },
  { label: "Ticker", key: "ticker" },
  { label: "TF", key: "timeframe" },
  { label: "Status", key: "status" },
  { label: "Trades", key: "total_trades", align: "right", title: "Backtest trade count over 6yr" },
  { label: "Total $", key: "total_return", align: "right", title: "6yr total $ at algo capital" },
  {
    label: "Annual $",
    key: "expected_annual_dollars",
    align: "right",
    title: "Total $ / 6 (rough annualized)",
  },
  {
    label: "R/trade",
    key: "expected_r_per_trade",
    align: "right",
    title: "Expected R per trade (scale-invariant)",
  },
  { label: "Worst DD", key: "max_drawdown", align: "right", title: "Worst drawdown during 6yr backtest" },
];

function MatrixHeader({
  sortKey,
  dir,
  onSort,
}: {
  sortKey: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
}) {
  return (
    <thead className="border-b text-muted-foreground">
      <tr>
        {COLUMNS.map((c) => (
          <HeaderCell
            key={c.key}
            label={c.label}
            sortKey={c.key}
            currentKey={sortKey}
            dir={dir}
            onSort={onSort}
            align={c.align}
            title={c.title}
          />
        ))}
        <th className="p-2.5" />
      </tr>
    </thead>
  );
}

function MatrixRow({ r }: { r: StrategyMatrixRow }) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30">
      <td className="p-2.5 max-w-[200px] truncate">{r.strategy_name ?? "—"}</td>
      <td className="p-2.5 font-mono">{r.ticker ?? "—"}</td>
      <td className="p-2.5">{r.timeframe ?? "—"}</td>
      <td className="p-2.5">
        <Badge variant={STATUS_BADGE[r.status].variant} className="text-[10px]">
          {STATUS_BADGE[r.status].label}
        </Badge>
      </td>
      <td className="p-2.5 text-right tabular-nums">{r.total_trades ?? "—"}</td>
      <td className="p-2.5 text-right tabular-nums">{fmtCurrency(r.total_return)}</td>
      <td className="p-2.5 text-right tabular-nums font-medium">
        {fmtCurrency(r.expected_annual_dollars)}
      </td>
      <td className="p-2.5 text-right tabular-nums">{fmtR(r.expected_r_per_trade)}</td>
      <td className="p-2.5 text-right tabular-nums">{fmtPercent(r.max_drawdown)}</td>
      <td className="p-2.5">
        <Link
          href={`/algorithms/${r.algorithm_id}`}
          className="text-muted-foreground hover:text-foreground"
          title="Open algorithm detail page"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </td>
    </tr>
  );
}

const ASC_KEYS = new Set<SortKey>(["max_drawdown", "strategy_name", "ticker", "timeframe"]);

export function StrategyMatrixTable({ rows }: { rows: StrategyMatrixRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("expected_annual_dollars");
  const [dir, setDir] = useState<1 | -1>(-1);

  function setSort(k: SortKey) {
    if (k === sortKey) {
      setDir((d) => (d === 1 ? -1 : 1));
      return;
    }
    setSortKey(k);
    setDir(ASC_KEYS.has(k) ? 1 : -1);
  }

  const sorted = useMemo(
    () => [...rows].sort((a, b) => compare(a, b, sortKey, dir)),
    [rows, sortKey, dir]
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Per-algo performance</CardTitle>
        <p className="text-xs text-muted-foreground">
          Backtest totals from <code>algorithms.backtest_results</code>. Click a column header to
          sort. Click the arrow icon to open the algo detail page.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <MatrixHeader sortKey={sortKey} dir={dir} onSort={setSort} />
          <tbody>
            {sorted.map((r) => (
              <MatrixRow key={r.algorithm_id} r={r} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
