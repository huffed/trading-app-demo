"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Eye, Loader2, MinusCircle, Plus, X } from "lucide-react";
import { runLiveSignal } from "@/app/(dashboard)/algorithms/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAddWatchlistItem, useRemoveWatchlistItem, useWatchlist } from "@/hooks/use-watchlist";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import type { WatchlistItem } from "@/types/watchlist";

const ADDED_BY_LABELS: Record<string, string> = { user: "Manual", ai: "AI", csv: "CSV" };

function SignalBadge({ signal }: { signal: SignalResult["signal"] }) {
  if (signal === "buy") return <Badge className="bg-[var(--profit)]/10 text-[var(--profit)]"><CheckCircle2 className="mr-1 h-3 w-3" />Buy</Badge>;
  if (signal === "hold") return <Badge className="bg-yellow-500/10 text-yellow-500"><MinusCircle className="mr-1 h-3 w-3" />Hold</Badge>;
  return <Badge variant="secondary"><AlertCircle className="mr-1 h-3 w-3" />No Signal</Badge>;
}

function SignalDetail({ data }: { data: SignalResult }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <SignalBadge signal={data.signal} />
        <span className="text-xs text-muted-foreground">Confidence: {data.confidence}%</span>
      </div>
      <p className="text-sm leading-relaxed">{data.reasoning}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-muted-foreground">Articles:</span> {data.articles_count}</div>
        <div><span className="text-muted-foreground">Avg sentiment:</span> {data.avg_sentiment.toFixed(3)}</div>
      </div>
      {data.conditions_evaluated.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Condition Results</p>
          {data.conditions_evaluated.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <span className={c.met ? "text-[var(--profit)]" : "text-[var(--loss)]"}>{c.met ? "PASS" : "FAIL"}</span>
              <span>{c.metric} {c.operator} {c.threshold}</span>
              <span className="text-muted-foreground">(actual: {c.value})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WatchlistRow({ item, hasSentiment, signalResult, isChecking, onCheck, onRemove, isRemoving, onToggleDetail, isDetailOpen }: {
  item: WatchlistItem; hasSentiment: boolean; signalResult?: SignalResult; isChecking: boolean;
  onCheck: () => void; onRemove: () => void; isRemoving: boolean; onToggleDetail: () => void; isDetailOpen: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 py-1.5">
        <span className="font-mono text-sm font-medium min-w-[60px]">{item.ticker}</span>
        <span className="text-xs text-muted-foreground truncate flex-1">{item.name || "\u00A0"}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">{ADDED_BY_LABELS[item.added_by] ?? item.added_by}</Badge>
        {hasSentiment && (signalResult ? (
          <button onClick={onToggleDetail} className="cursor-pointer" type="button"><SignalBadge signal={signalResult.signal} /></button>
        ) : (
          <Button size="xs" variant="ghost" onClick={onCheck} disabled={isChecking}>
            {isChecking ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check"}
          </Button>
        ))}
        <Button size="icon-xs" variant="ghost" onClick={onRemove} disabled={isRemoving}><X className="h-3 w-3" /></Button>
      </div>
      {isDetailOpen && signalResult && <SignalDetail data={signalResult} />}
    </div>
  );
}

function WatchlistItems({ items, algorithmId, hasSentiment, onRemove, isRemoving }: {
  items: WatchlistItem[]; algorithmId: string; hasSentiment: boolean; onRemove: (id: string) => void; isRemoving: boolean;
}) {
  const [signalResults, setSignalResults] = useState<Record<string, SignalResult>>({});
  const [checkingTicker, setCheckingTicker] = useState<string | null>(null);
  const [isCheckingAll, setIsCheckingAll] = useState(false);
  const [checkedCount, setCheckedCount] = useState(0);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  async function handleCheck(ticker: string) {
    setCheckingTicker(ticker);
    try {
      const result = await runLiveSignal(algorithmId, ticker);
      if (result.success) setSignalResults((prev) => ({ ...prev, [ticker]: result.data as SignalResult }));
    } catch { /* user can retry */ } finally { setCheckingTicker(null); }
  }

  async function handleCheckAll() {
    setIsCheckingAll(true);
    setCheckedCount(0);
    setSignalResults({});
    for (const item of items) {
      try {
        const result = await runLiveSignal(algorithmId, item.ticker);
        if (result.success) setSignalResults((prev) => ({ ...prev, [item.ticker]: result.data as SignalResult }));
      } catch { /* continue */ }
      setCheckedCount((c) => c + 1);
    }
    setIsCheckingAll(false);
  }

  return (
    <>
      <div className="divide-y">
        {items.map((item) => (
          <WatchlistRow
            key={item.id} item={item} hasSentiment={hasSentiment}
            signalResult={signalResults[item.ticker]}
            isChecking={checkingTicker === item.ticker || (isCheckingAll && !signalResults[item.ticker])}
            onCheck={() => handleCheck(item.ticker)} onRemove={() => onRemove(item.id)} isRemoving={isRemoving}
            onToggleDetail={() => setExpandedTicker((p) => (p === item.ticker ? null : item.ticker))}
            isDetailOpen={expandedTicker === item.ticker}
          />
        ))}
      </div>
      {hasSentiment && (
        <Button variant="outline" size="sm" onClick={handleCheckAll} disabled={isCheckingAll || !!checkingTicker} className="w-full">
          {isCheckingAll ? `Checking... (${checkedCount}/${items.length})` : "Check All Signals"}
        </Button>
      )}
    </>
  );
}

export function WatchlistCard({ algorithmId, hasSentimentConditions }: { algorithmId: string; hasSentimentConditions: boolean }) {
  const { data: items = [], isLoading } = useWatchlist(algorithmId);
  const addMutation = useAddWatchlistItem();
  const removeMutation = useRemoveWatchlistItem();
  const [newTicker, setNewTicker] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  function handleAdd() {
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;
    setAddError(null);
    addMutation.mutate({ algorithmId, ticker }, {
      onSuccess: (r) => { if (r.success) setNewTicker(""); else setAddError(r.error); },
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Eye className="h-4 w-4" />Watchlist
          {items.length > 0 && <Badge variant="secondary" className="ml-1">{items.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input placeholder="AAPL" value={newTicker} onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }} className="flex-1" />
          <Button size="sm" onClick={handleAdd} disabled={addMutation.isPending || !newTicker.trim()}><Plus className="h-4 w-4" /></Button>
        </div>
        {addError && <p className="text-xs text-[var(--loss)]">{addError}</p>}
        {isLoading && <p className="text-xs text-muted-foreground text-center py-4">Loading watchlist...</p>}
        {!isLoading && items.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No tickers yet. Add one above or create this algorithm from a CSV trade history to auto-populate.
          </p>
        )}
        {items.length > 0 && (
          <WatchlistItems items={items} algorithmId={algorithmId} hasSentiment={hasSentimentConditions}
            onRemove={(id) => removeMutation.mutate(id)} isRemoving={removeMutation.isPending} />
        )}
      </CardContent>
    </Card>
  );
}
