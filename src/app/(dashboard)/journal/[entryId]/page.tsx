"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { AiAnalysisCard } from "@/components/journal/ai-analysis-card";
import { getEmotionDisplay } from "@/components/journal/emotion-picker";
import { JournalForm } from "@/components/journal/journal-form";
import { StarRating } from "@/components/journal/star-rating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useJournalEntry, useDeleteJournalEntry, useTradesForLinking } from "@/hooks/use-journal";
import { ENTRY_TYPE_LABELS } from "@/lib/constants/journal";
import type { JournalEntry } from "@/types/journal";

interface EntryMetaProps {
  entry: JournalEntry;
}

function EntryMeta({ entry }: EntryMetaProps) {
  const emotion = getEmotionDisplay(entry.emotion);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{ENTRY_TYPE_LABELS[entry.entry_type] ?? entry.entry_type}</Badge>
        <Badge variant="secondary">
          {emotion.emoji} {emotion.label}
        </Badge>
        {entry.self_rating != null && <StarRating value={entry.self_rating} readOnly size="sm" />}
      </div>
      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </>
  );
}

type LinkedTrade = {
  id: string;
  symbol: string;
  side: string;
  entry_date: string;
  realized_pnl: number | null;
};

interface EntryViewProps {
  entry: JournalEntry;
  linkedTrades: LinkedTrade[];
  onEdit: () => void;
  onDelete: () => void;
}

function EntryHeader({
  entry,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm" render={<Link href="/journal" />} nativeButton={false}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{entry.title}</h1>
        <p className="text-xs text-muted-foreground">
          {new Date(entry.created_at).toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function LinkedTradesCard({ linkedTrades }: { linkedTrades: LinkedTrade[] }) {
  if (linkedTrades.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm font-medium mb-2">Linked Trades</h3>
        <div className="space-y-1">
          {linkedTrades.map((trade) => (
            <div key={trade.id} className="flex items-center justify-between text-sm">
              <span>
                <span className="font-medium">{trade.symbol}</span>{" "}
                <span className="text-muted-foreground">
                  {trade.side} &middot; {new Date(trade.entry_date).toLocaleDateString()}
                </span>
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EntryView({ entry, linkedTrades, onEdit, onDelete }: EntryViewProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <EntryHeader entry={entry} onEdit={onEdit} onDelete={onDelete} />
      <EntryMeta entry={entry} />
      <Card>
        <CardContent className="p-6">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {entry.content || (
              <span className="text-muted-foreground italic">No content written.</span>
            )}
          </div>
        </CardContent>
      </Card>
      <LinkedTradesCard linkedTrades={linkedTrades} />
      {(entry.ai_analysis || entry.linked_trade_ids.length > 0) && (
        <AiAnalysisCard
          entryId={entry.id}
          analysis={entry.ai_analysis}
          analyzedAt={entry.ai_analyzed_at}
        />
      )}
    </div>
  );
}

function EntryLoadingSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EntryNotFound() {
  return (
    <div className="mx-auto max-w-2xl text-center py-16">
      <p className="text-sm text-muted-foreground">Entry not found</p>
      <Button
        className="mt-4"
        variant="outline"
        render={<Link href="/journal" />}
        nativeButton={false}
      >
        Back to Journal
      </Button>
    </div>
  );
}

function EditEntryView({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Edit Entry</h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <JournalForm entry={entry} onSuccess={onClose} />
        </CardContent>
      </Card>
    </div>
  );
}

interface DeleteDialogProps {
  entry: JournalEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
}

function DeleteEntryDialog({ entry, open, onOpenChange, onConfirm, isPending }: DeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Delete Entry</DialogTitle>
          <DialogDescription>
            Delete &ldquo;{entry.title}&rdquo;? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={isPending} onClick={onConfirm}>
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function JournalEntryPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const router = useRouter();
  const { data: entry, isLoading } = useJournalEntry(entryId);
  const deleteMutation = useDeleteJournalEntry();
  const { data: trades } = useTradesForLinking();

  const [isEditing, setIsEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  if (isLoading) return <EntryLoadingSkeleton />;
  if (!entry) return <EntryNotFound />;

  const linkedTrades = (trades ?? []).filter((t) => entry.linked_trade_ids.includes(t.id));

  if (isEditing) {
    return <EditEntryView entry={entry} onClose={() => setIsEditing(false)} />;
  }

  return (
    <>
      <EntryView
        entry={entry}
        linkedTrades={linkedTrades}
        onEdit={() => setIsEditing(true)}
        onDelete={() => setShowDelete(true)}
      />
      <DeleteEntryDialog
        entry={entry}
        open={showDelete}
        onOpenChange={setShowDelete}
        onConfirm={() => {
          deleteMutation.mutate(entry.id, {
            onSuccess: () => router.push("/journal"),
          });
        }}
        isPending={deleteMutation.isPending}
      />
    </>
  );
}
