"use client";

import { useState } from "react";
import { Eye, Plus } from "lucide-react";
import { runLiveSignal } from "@/app/(dashboard)/algorithms/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAddWatchlistItem, useRemoveWatchlistItem, useWatchlist } from "@/hooks/use-watchlist";
import { COMMODITIES, FOREX_PAIRS, type InstrumentMeta } from "@/lib/constants/markets";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import type { WatchlistItem } from "@/types/watchlist";
import { WatchlistRow } from "./watchlist-row";

function getPlaceholder(assetClass?: string): string {
  if (assetClass === "forex") return "EUR/USD";
  if (assetClass === "commodity") return "XAU/USD";
  if (assetClass === "crypto") return "BTC/USD";
  return "AAPL";
}

function getSuggestedInstruments(assetClass?: string): InstrumentMeta[] {
  if (assetClass === "forex") return FOREX_PAIRS;
  if (assetClass === "commodity") return COMMODITIES;
  return [];
}

function useSignalState(algorithmId: string, items: WatchlistItem[]) {
  const [signalResults, setSignalResults] = useState<Record<string, SignalResult>>({});
  const [signalError, setSignalError] = useState<string | null>(null);
  const [checkingTicker, setCheckingTicker] = useState<string | null>(null);
  const [isCheckingAll, setIsCheckingAll] = useState(false);
  const [checkedCount, setCheckedCount] = useState(0);

  async function handleCheck(ticker: string) {
    setCheckingTicker(ticker);
    setSignalError(null);
    try {
      const result = await runLiveSignal(algorithmId, ticker);
      if (result.success) {
        setSignalResults((prev) => ({ ...prev, [ticker]: result.data as SignalResult }));
      } else {
        setSignalError(`${ticker}: ${result.error}`);
      }
    } catch (err) {
      setSignalError(`${ticker}: ${err instanceof Error ? err.message : "Signal check failed"}`);
    } finally {
      setCheckingTicker(null);
    }
  }

  async function handleCheckAll() {
    setIsCheckingAll(true);
    setCheckedCount(0);
    setSignalResults({});
    setSignalError(null);
    for (const item of items) {
      try {
        const result = await runLiveSignal(algorithmId, item.ticker);
        if (result.success) {
          setSignalResults((prev) => ({ ...prev, [item.ticker]: result.data as SignalResult }));
        }
      } catch {
        /* continue */
      }
      setCheckedCount((c) => c + 1);
    }
    setIsCheckingAll(false);
  }

  return {
    signalResults,
    signalError,
    checkingTicker,
    isCheckingAll,
    checkedCount,
    handleCheck,
    handleCheckAll,
  };
}

function WatchlistItems({
  items,
  algorithmId,
  hasSentiment,
  onRemove,
  isRemoving,
}: {
  items: WatchlistItem[];
  algorithmId: string;
  hasSentiment: boolean;
  onRemove: (id: string) => void;
  isRemoving: boolean;
}) {
  const sig = useSignalState(algorithmId, items);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  return (
    <>
      <div className="divide-y">
        {items.map((item) => (
          <WatchlistRow
            key={item.id}
            item={item}
            hasSentiment={hasSentiment}
            signalResult={sig.signalResults[item.ticker]}
            isChecking={
              sig.checkingTicker === item.ticker ||
              (sig.isCheckingAll && !sig.signalResults[item.ticker])
            }
            onCheck={() => sig.handleCheck(item.ticker)}
            onRemove={() => onRemove(item.id)}
            isRemoving={isRemoving}
            onToggleDetail={() =>
              setExpandedTicker((p) => (p === item.ticker ? null : item.ticker))
            }
            isDetailOpen={expandedTicker === item.ticker}
          />
        ))}
      </div>
      {sig.signalError && <p className="text-xs text-[var(--loss)]">{sig.signalError}</p>}
      {hasSentiment && (
        <Button
          variant="outline"
          size="sm"
          onClick={sig.handleCheckAll}
          disabled={sig.isCheckingAll || !!sig.checkingTicker}
          className="w-full"
        >
          {sig.isCheckingAll
            ? `Checking... (${sig.checkedCount}/${items.length})`
            : "Check All Signals"}
        </Button>
      )}
    </>
  );
}

function AddTickerForm({
  onAdd,
  isPending,
  addError,
  assetClass,
  existingTickers,
}: {
  onAdd: (ticker: string) => void;
  isPending: boolean;
  addError: string | null;
  assetClass?: string;
  existingTickers: string[];
}) {
  const [newTicker, setNewTicker] = useState("");
  const suggestions = getSuggestedInstruments(assetClass);
  const existing = new Set(existingTickers.map((t) => t.toUpperCase()));
  const remainingSuggestions = suggestions.filter((s) => !existing.has(s.symbol.toUpperCase()));

  function handleAdd(symbol?: string) {
    const ticker = (symbol ?? newTicker).trim().toUpperCase();
    if (!ticker) return;
    onAdd(ticker);
    if (!symbol) setNewTicker("");
  }

  return (
    <>
      <div className="flex gap-2">
        <Input
          placeholder={getPlaceholder(assetClass)}
          value={newTicker}
          onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          className="flex-1"
        />
        <Button size="sm" onClick={() => handleAdd()} disabled={isPending || !newTicker.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {addError && <p className="text-xs text-[var(--loss)]">{addError}</p>}
      {remainingSuggestions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Suggested:</p>
          <div className="flex flex-wrap gap-1.5">
            {remainingSuggestions.map((s) => (
              <Button
                key={s.symbol}
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs font-mono"
                disabled={isPending}
                onClick={() => handleAdd(s.symbol)}
                title={`${s.name} — ${s.description}`}
              >
                {s.symbol}
              </Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function WatchlistCard({
  algorithmId,
  hasSentimentConditions,
  assetClass,
}: {
  algorithmId: string;
  hasSentimentConditions: boolean;
  assetClass?: string;
}) {
  const { data: items = [], isLoading } = useWatchlist(algorithmId);
  const addMutation = useAddWatchlistItem();
  const removeMutation = useRemoveWatchlistItem();
  const [addError, setAddError] = useState<string | null>(null);

  function handleAdd(ticker: string) {
    setAddError(null);
    addMutation.mutate(
      { algorithmId, ticker },
      {
        onSuccess: (r) => {
          if (!r.success) {
            setAddError(r.error);
          }
        },
      }
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Eye className="h-4 w-4" />
          Watchlist
          {items.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {items.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <AddTickerForm
          onAdd={handleAdd}
          isPending={addMutation.isPending}
          addError={addError}
          assetClass={assetClass}
          existingTickers={items.map((i) => i.ticker)}
        />
        {isLoading && (
          <p className="text-xs text-muted-foreground text-center py-4">Loading watchlist...</p>
        )}
        {!isLoading && items.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No tickers yet. Add one above or create this algorithm from a CSV trade history to
            auto-populate.
          </p>
        )}
        {items.length > 0 && (
          <WatchlistItems
            items={items}
            algorithmId={algorithmId}
            hasSentiment={hasSentimentConditions}
            onRemove={(id) => removeMutation.mutate(id)}
            isRemoving={removeMutation.isPending}
          />
        )}
      </CardContent>
    </Card>
  );
}
