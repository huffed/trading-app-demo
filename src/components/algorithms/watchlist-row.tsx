"use client";

import { AlertCircle, CheckCircle2, Loader2, MinusCircle, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WATCHLIST_ADDED_BY_LABELS } from "@/lib/constants/algorithm";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import { formatRelativeTime } from "@/lib/utils/pnl";
import type { WatchlistAddedBy, WatchlistItem } from "@/types/watchlist";

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

function SourceBadge({ addedBy }: { addedBy: WatchlistAddedBy }) {
  const label = WATCHLIST_ADDED_BY_LABELS[addedBy] ?? addedBy;
  // CSV / AI rows get a tinted variant so the operator can spot at a
  // glance whether they curated this pair themselves or whether it landed
  // via discovery / trade-history seeding.
  const variant: "outline" | "secondary" = addedBy === "user" ? "outline" : "secondary";
  return (
    <Badge variant={variant} className="text-[10px] px-1.5 py-0 font-normal">
      {label}
    </Badge>
  );
}

function PausedBadge({ pausedAt }: { pausedAt: string | null }) {
  return (
    <Badge className="bg-yellow-500/10 text-yellow-500 text-[10px] px-1.5 py-0 font-normal">
      Paused {pausedAt ? `· ${formatRelativeTime(pausedAt)}` : ""}
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

function ActiveActions({
  hasSentiment,
  signalResult,
  isChecking,
  onCheck,
  onToggleDetail,
}: {
  hasSentiment: boolean;
  signalResult?: SignalResult;
  isChecking: boolean;
  onCheck: () => void;
  onToggleDetail: () => void;
}) {
  if (!hasSentiment) return null;
  if (signalResult) {
    return (
      <button onClick={onToggleDetail} className="cursor-pointer" type="button">
        <SignalBadge signal={signalResult.signal} />
      </button>
    );
  }
  return (
    <Button size="xs" variant="ghost" onClick={onCheck} disabled={isChecking}>
      {isChecking ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check"}
    </Button>
  );
}

function ResumeButton({
  reason,
  isResuming,
  onResume,
}: {
  reason: string | null;
  isResuming: boolean;
  onResume: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={onResume}
      disabled={isResuming}
      title={reason ?? "Resume scanning"}
    >
      {isResuming ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <>
          <Play className="mr-1 h-3 w-3" />
          Resume
        </>
      )}
    </Button>
  );
}

export function WatchlistRow({
  item,
  hasSentiment,
  signalResult,
  isChecking,
  onCheck,
  onRemove,
  onResume,
  isRemoving,
  isResuming,
  onToggleDetail,
  isDetailOpen,
}: {
  item: WatchlistItem;
  hasSentiment: boolean;
  signalResult?: SignalResult;
  isChecking: boolean;
  onCheck: () => void;
  onRemove: () => void;
  onResume: () => void;
  isRemoving: boolean;
  isResuming: boolean;
  onToggleDetail: () => void;
  isDetailOpen: boolean;
}) {
  const isPaused = item.auto_paused === true;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 py-1.5">
        <span
          className={`font-mono text-sm font-medium min-w-[60px] ${
            isPaused ? "text-muted-foreground line-through" : ""
          }`}
        >
          {item.ticker}
        </span>
        <span
          className={`text-xs truncate flex-1 ${
            isPaused ? "text-muted-foreground/60" : "text-muted-foreground"
          }`}
        >
          {item.name || "\u00A0"}
        </span>
        {isPaused && <PausedBadge pausedAt={item.auto_paused_at} />}
        <SourceBadge addedBy={item.added_by} />
        {!isPaused && (
          <ActiveActions
            hasSentiment={hasSentiment}
            signalResult={signalResult}
            isChecking={isChecking}
            onCheck={onCheck}
            onToggleDetail={onToggleDetail}
          />
        )}
        {isPaused && (
          <ResumeButton
            reason={item.auto_paused_reason}
            isResuming={isResuming}
            onResume={onResume}
          />
        )}
        <Button size="icon-xs" variant="ghost" onClick={onRemove} disabled={isRemoving}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      {isPaused && item.auto_paused_reason && (
        <p className="text-[11px] text-muted-foreground pl-[60px] -mt-1">
          {item.auto_paused_reason}
        </p>
      )}
      {isDetailOpen && signalResult && <SignalDetail data={signalResult} />}
    </div>
  );
}
