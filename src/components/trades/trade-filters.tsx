"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ASSET_CLASS_LABELS } from "@/lib/constants/algorithm";
import { useTradeFilterStore } from "@/stores/trade-filter-store";
import type { AssetClass, TradeSide, TradeStatus } from "@/types/trade";

function StatusSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradeStatus | undefined) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "all" ? undefined : (v as TradeStatus))}
    >
      <SelectTrigger className="h-8 w-28">
        <SelectValue placeholder="Status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Status</SelectItem>
        <SelectItem value="open">Open</SelectItem>
        <SelectItem value="closed">Closed</SelectItem>
      </SelectContent>
    </Select>
  );
}

function SideSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradeSide | undefined) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "all" ? undefined : (v as TradeSide))}
    >
      <SelectTrigger className="h-8 w-24">
        <SelectValue placeholder="Side" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Sides</SelectItem>
        <SelectItem value="long">Long</SelectItem>
        <SelectItem value="short">Short</SelectItem>
      </SelectContent>
    </Select>
  );
}

function AssetClassSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: AssetClass | undefined) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "all" ? undefined : (v as AssetClass))}
    >
      <SelectTrigger className="h-8 w-28">
        <SelectValue placeholder="Asset" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Assets</SelectItem>
        {Object.entries(ASSET_CLASS_LABELS).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function TradeFilters() {
  const { filters, setFilter, resetFilters } = useTradeFilterStore();

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Search symbol..."
        className="h-8 w-36"
        value={filters.symbol ?? ""}
        onChange={(e) => setFilter("symbol", e.target.value || undefined)}
      />
      <StatusSelect value={filters.status ?? "all"} onChange={(v) => setFilter("status", v)} />
      <SideSelect value={filters.side ?? "all"} onChange={(v) => setFilter("side", v)} />
      <AssetClassSelect
        value={filters.asset_class ?? "all"}
        onChange={(v) => setFilter("asset_class", v)}
      />
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          <X className="mr-1 h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
