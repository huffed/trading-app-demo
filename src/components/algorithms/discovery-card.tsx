"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Sparkles } from "lucide-react";
import { discoverTickers } from "@/app/(dashboard)/algorithms/discovery-actions";
import { addWatchlistItem, bulkAddWatchlistItems } from "@/app/(dashboard)/algorithms/watchlist-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DiscoverySuggestion } from "@/types/watchlist";

function SuggestionRow({ suggestion, algorithmId, isAdded, onAdded, onWatchlistChanged }: {
  suggestion: DiscoverySuggestion; algorithmId: string; isAdded: boolean;
  onAdded: (ticker: string) => void; onWatchlistChanged: () => void;
}) {
  const [isAdding, setIsAdding] = useState(false);

  async function handleAdd() {
    setIsAdding(true);
    try {
      const result = await addWatchlistItem(algorithmId, suggestion.ticker, suggestion.name, "ai", suggestion.reasoning);
      if (result.success) { onAdded(suggestion.ticker); onWatchlistChanged(); }
    } catch { /* best effort */ } finally { setIsAdding(false); }
  }

  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{suggestion.ticker}</span>
          <span className="text-xs text-muted-foreground truncate">{suggestion.name}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="outline" className="text-[10px]">{suggestion.sector}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{suggestion.reasoning}</p>
      </div>
      <Button size="icon-xs" variant={isAdded ? "secondary" : "ghost"} onClick={handleAdd} disabled={isAdded || isAdding}>
        {isAdding && <Loader2 className="h-3 w-3 animate-spin" />}
        {!isAdding && isAdded && <Check className="h-3 w-3" />}
        {!isAdding && !isAdded && <Plus className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function SuggestionList({ suggestions, algorithmId, addedTickers, onAdded, onAddAll, isAddingAll, onWatchlistChanged }: {
  suggestions: DiscoverySuggestion[]; algorithmId: string; addedTickers: Set<string>;
  onAdded: (ticker: string) => void; onAddAll: () => void; isAddingAll: boolean; onWatchlistChanged: () => void;
}) {
  const allAdded = suggestions.every((s) => addedTickers.has(s.ticker));
  return (
    <>
      <div className="divide-y">
        {suggestions.map((s) => (
          <SuggestionRow key={s.ticker} suggestion={s} algorithmId={algorithmId}
            isAdded={addedTickers.has(s.ticker)} onAdded={onAdded} onWatchlistChanged={onWatchlistChanged} />
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={onAddAll} disabled={allAdded || isAddingAll} className="w-full">
        {isAddingAll && "Adding..."}
        {!isAddingAll && allAdded && "All added to watchlist"}
        {!isAddingAll && !allAdded && "Add All to Watchlist"}
      </Button>
    </>
  );
}

export function DiscoveryCard({ algorithmId }: { algorithmId: string }) {
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<DiscoverySuggestion[]>([]);
  const [addedTickers, setAddedTickers] = useState<Set<string>>(new Set());
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isAddingAll, setIsAddingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function invalidateWatchlist() {
    queryClient.invalidateQueries({ queryKey: ["watchlist"] });
  }

  async function handleDiscover() {
    setIsDiscovering(true);
    setError(null);
    setSuggestions([]);
    setAddedTickers(new Set());
    try {
      const result = await discoverTickers(algorithmId);
      if (result.success) setSuggestions(result.data);
      else setError(result.error);
    } catch { setError("Discovery failed. Please try again."); } finally { setIsDiscovering(false); }
  }

  async function handleAddAll() {
    const toAdd = suggestions.filter((s) => !addedTickers.has(s.ticker));
    if (toAdd.length === 0) return;
    setIsAddingAll(true);
    try {
      const result = await bulkAddWatchlistItems(
        algorithmId,
        toAdd.map((s) => ({ symbol: s.ticker, name: s.name })),
        "ai"
      );
      if (result.success) { setAddedTickers(new Set(suggestions.map((s) => s.ticker))); invalidateWatchlist(); }
    } catch { /* best effort */ } finally { setIsAddingAll(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4" />Discovery Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          AI suggests stocks matching your trading profile and strategy. Discoveries are added to your watchlist.
        </p>
        <Button variant="outline" size="sm" onClick={handleDiscover} disabled={isDiscovering} className="w-full">
          {isDiscovering ? <><Loader2 className="mr-2 h-3 w-3 animate-spin" />Discovering...</> : "Discover Tickers"}
        </Button>
        {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
        {suggestions.length > 0 && (
          <SuggestionList suggestions={suggestions} algorithmId={algorithmId}
            addedTickers={addedTickers} onAdded={(t) => setAddedTickers((prev) => new Set(prev).add(t))}
            onAddAll={handleAddAll} isAddingAll={isAddingAll} onWatchlistChanged={invalidateWatchlist} />
        )}
      </CardContent>
    </Card>
  );
}
