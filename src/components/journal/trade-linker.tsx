"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useTradesForLinking } from "@/hooks/use-journal";
import { formatDate } from "@/lib/utils/date";
import { formatPnl, pnlColorClass } from "@/lib/utils/pnl";

type LinkableTrade = {
  id: string;
  symbol: string;
  side: string;
  entry_date: string;
  realized_pnl: number | null;
};

interface TradeDropdownProps {
  available: LinkableTrade[];
  onSelect: (id: string) => void;
}

function TradeDropdown({ available, onSelect }: TradeDropdownProps) {
  return (
    <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-lg border border-border bg-popover p-1 shadow-md">
      {available.slice(0, 8).map((trade) => (
        <button
          key={trade.id}
          type="button"
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(trade.id)}
        >
          <span className="flex items-center gap-2">
            <span className="font-medium">{trade.symbol}</span>
            <span className="text-xs text-muted-foreground">{trade.side}</span>
            <span className="text-xs text-muted-foreground">
              {formatDate(trade.entry_date)}
            </span>
          </span>
          {trade.realized_pnl != null && (
            <span className={`text-xs font-medium ${pnlColorClass(trade.realized_pnl)}`}>
              {formatPnl(trade.realized_pnl)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SelectedTrades({
  selected,
  onRemove,
}: {
  selected: LinkableTrade[];
  onRemove: (id: string) => void;
}) {
  if (selected.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {selected.map((trade) => (
        <Badge key={trade.id} variant="secondary" className="gap-1 text-xs">
          {trade.symbol} ({trade.side})
          <button
            type="button"
            onClick={() => onRemove(trade.id)}
            className="ml-0.5 cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

interface TradeLinkerProps {
  value: string[];
  onChange: (ids: string[]) => void;
}

export function TradeLinker({ value, onChange }: TradeLinkerProps) {
  const [search, setSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const { data: trades } = useTradesForLinking(search || undefined);

  const available = (trades ?? []).filter((t) => !value.includes(t.id));
  const selected = (trades ?? []).filter((t) => value.includes(t.id));

  function addTrade(id: string) {
    onChange([...value, id]);
    setSearch("");
    setShowDropdown(false);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          placeholder="Search trades by symbol..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => setShowDropdown(false)}
        />
        {showDropdown && available.length > 0 && (
          <TradeDropdown available={available} onSelect={addTrade} />
        )}
      </div>
      <SelectedTrades
        selected={selected}
        onRemove={(id) => onChange(value.filter((v) => v !== id))}
      />
      {value.length > 0 && selected.length < value.length && (
        <p className="text-xs text-muted-foreground">
          {value.length - selected.length} linked trade
          {value.length - selected.length !== 1 && "s"} not shown (may have been deleted)
        </p>
      )}
    </div>
  );
}
