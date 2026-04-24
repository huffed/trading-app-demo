"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ENTRY_TYPE_SHORT_LABELS } from "@/lib/constants/journal";
import type { JournalEntry } from "@/types/journal";
import { getEmotionDisplay } from "./emotion-picker";
import { StarRating } from "./star-rating";

interface JournalCardProps {
  entry: JournalEntry;
}

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export function JournalCard({ entry }: JournalCardProps) {
  const emotion = getEmotionDisplay(entry.emotion);
  const preview = entry.content.length > 150 ? entry.content.slice(0, 150) + "..." : entry.content;

  return (
    <Link href={`/journal/${entry.id}`}>
      <Card className="h-full transition-colors hover:border-foreground/20 cursor-pointer">
        <CardContent className="p-4 space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-sm leading-tight line-clamp-2">{entry.title}</h3>
            <span className="shrink-0 text-xs text-muted-foreground">
              {timeAgo(entry.created_at)}
            </span>
          </div>

          {/* Badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-xs">
              {ENTRY_TYPE_SHORT_LABELS[entry.entry_type] ?? entry.entry_type}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {emotion.emoji} {emotion.label}
            </Badge>
            {entry.ai_analysis && (
              <Badge className="text-xs gap-1 bg-primary/10 text-primary">
                <Sparkles className="h-3 w-3" />
                AI
              </Badge>
            )}
          </div>

          {/* Content preview */}
          {preview && <p className="text-xs text-muted-foreground leading-relaxed">{preview}</p>}

          {/* Footer */}
          <div className="flex items-center justify-between">
            {entry.self_rating != null ? (
              <StarRating value={entry.self_rating} readOnly size="sm" />
            ) : (
              <span />
            )}
            {entry.linked_trade_ids.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {entry.linked_trade_ids.length} trade
                {entry.linked_trade_ids.length !== 1 && "s"} linked
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
