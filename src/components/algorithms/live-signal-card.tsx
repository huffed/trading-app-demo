"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, MinusCircle, Newspaper } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLiveSignal } from "@/hooks/use-live-signal";
import type { SignalResult } from "@/lib/signals/evaluate-live";

function SignalBadge({ signal }: { signal: SignalResult["signal"] }) {
  if (signal === "buy") {
    return <Badge className="bg-[var(--profit)]/10 text-[var(--profit)]"><CheckCircle2 className="mr-1 h-3 w-3" />Buy Signal</Badge>;
  }
  if (signal === "hold") {
    return <Badge className="bg-yellow-500/10 text-yellow-500"><MinusCircle className="mr-1 h-3 w-3" />Hold</Badge>;
  }
  return <Badge variant="secondary"><AlertCircle className="mr-1 h-3 w-3" />No Signal</Badge>;
}

function SignalResults({ data }: { data: SignalResult }) {
  return (
    <div className="space-y-3">
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

export function LiveSignalCard({ algorithmId }: { algorithmId: string }) {
  const [ticker, setTicker] = useState("");
  const signal = useLiveSignal();

  function handleCheck() {
    if (!ticker.trim()) { return; }
    signal.mutate({ algorithmId, ticker: ticker.trim().toUpperCase() });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Newspaper className="h-4 w-4" />
          Live Signal Check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Evaluate sentiment conditions against current news data using AI analysis.
        </p>
        <div className="flex gap-2">
          <Input
            placeholder="QBTS"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className="flex-1"
          />
          <Button
            onClick={handleCheck}
            disabled={signal.isPending || !ticker.trim()}
            size="sm"
          >
            {signal.isPending ? "Checking..." : "Check Signal"}
          </Button>
        </div>
        {signal.isError && (
          <p className="text-xs text-[var(--loss)]">{signal.error.message}</p>
        )}
        {signal.data && <SignalResults data={signal.data} />}
      </CardContent>
    </Card>
  );
}
