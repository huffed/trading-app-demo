"use client";

import { AlertCircle, CheckCircle2, Loader2, MinusCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import type { WatchlistItem } from "@/types/watchlist";

function SignalBadge({ signal }: { signal: SignalResult["signal"] }) {
  if (signal === "buy") {
    return (
      <Badge className="bg-[var(--profit)]/10 text-[var(--profit)]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Buy
      </Badge>
    );
  }
  if (signal === "hold") {
    return (
      <Badge className="bg-yellow-500/10 text-yellow-500">
        <MinusCircle className="mr-1 h-3 w-3" />
        Hold
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <AlertCircle className="mr-1 h-3 w-3" />
      No Signal
    </Badge>
  );
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
        <div>
          <span className="text-muted-foreground">Articles:</span> {data.articles_count}
        </div>
        <div>
          <span className="text-muted-foreground">Avg sentiment:</span>{" "}
          {data.avg_sentiment.toFixed(3)}
        </div>
      </div>
      {data.conditions_evaluated.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Condition Results</p>
          {data.conditions_evaluated.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <span className={c.met ? "text-[var(--profit)]" : "text-[var(--loss)]"}>
                {c.met ? "PASS" : "FAIL"}
              </span>
              <span>
                {c.metric} {c.operator} {c.threshold}
              </span>
              <span className="text-muted-foreground">(actual: {c.value})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WatchlistRow({
  item,
  hasSentiment,
  signalResult,
  isChecking,
  onCheck,
  onRemove,
  isRemoving,
  onToggleDetail,
  isDetailOpen,
}: {
  item: WatchlistItem;
  hasSentiment: boolean;
  signalResult?: SignalResult;
  isChecking: boolean;
  onCheck: () => void;
  onRemove: () => void;
  isRemoving: boolean;
  onToggleDetail: () => void;
  isDetailOpen: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 py-1.5">
        <span className="font-mono text-sm font-medium min-w-[60px]">{item.ticker}</span>
        <span className="text-xs text-muted-foreground truncate flex-1">
          {item.name || "\u00A0"}
        </span>
        {hasSentiment &&
          (signalResult ? (
            <button onClick={onToggleDetail} className="cursor-pointer" type="button">
              <SignalBadge signal={signalResult.signal} />
            </button>
          ) : (
            <Button size="xs" variant="ghost" onClick={onCheck} disabled={isChecking}>
              {isChecking ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check"}
            </Button>
          ))}
        <Button size="icon-xs" variant="ghost" onClick={onRemove} disabled={isRemoving}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      {isDetailOpen && signalResult && <SignalDetail data={signalResult} />}
    </div>
  );
}
