"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ContextualTip } from "@/components/onboarding/contextual-tip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useJournalEntries } from "@/hooks/use-journal";

const EMOTION_CONFIG: Record<string, { label: string; color: string }> = {
  confident: { label: "Confident", color: "var(--color-chart-2)" },
  disciplined: { label: "Disciplined", color: "var(--color-chart-2)" },
  calm: { label: "Calm", color: "var(--color-chart-2)" },
  neutral: { label: "Neutral", color: "var(--color-chart-1)" },
  anxious: { label: "Anxious", color: "var(--color-chart-3)" },
  fearful: { label: "Fearful", color: "var(--color-chart-3)" },
  greedy: { label: "Greedy", color: "var(--color-chart-5)" },
  impulsive: { label: "Impulsive", color: "var(--color-chart-3)" },
  frustrated: { label: "Frustrated", color: "var(--color-chart-3)" },
};

function EmotionBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const width = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs text-muted-foreground w-6 text-right">{count}</span>
    </div>
  );
}

export function EmotionWidget() {
  const { data, isLoading } = useJournalEntries({}, 1, 50);
  const entries = data?.entries ?? [];

  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.emotion] = (counts[e.emotion] ?? 0) + 1;
  }

  const sorted = Object.entries(counts)
    .map(([emotion, count]) => ({
      emotion,
      count,
      config: EMOTION_CONFIG[emotion] ?? { label: emotion, color: "var(--color-chart-1)" },
    }))
    .sort((a, b) => b.count - a.count);

  const max = sorted.length > 0 ? sorted[0].count : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          Emotion Trends
          <ContextualTip tipId="emotion-trends" />
        </CardTitle>
        {entries.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            render={<Link href="/journal" />}
            nativeButton={false}
          >
            Journal
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-48 w-full" />}
        {!isLoading && sorted.length === 0 && (
          <div className="flex flex-col items-center py-8 text-center">
            <p className="text-sm text-muted-foreground">No journal entries yet</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              render={<Link href="/journal/new" />}
              nativeButton={false}
            >
              Write your first entry
            </Button>
          </div>
        )}
        {!isLoading && sorted.length > 0 && (
          <div className="space-y-2">
            {sorted.map(({ emotion, count, config }) => (
              <EmotionBar
                key={emotion}
                label={config.label}
                count={count}
                max={max}
                color={config.color}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
