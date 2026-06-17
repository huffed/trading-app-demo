"use client";

import Link from "next/link";
import { ArrowLeft, Grid3X3, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/constants/algorithm";

export function AlgoHeader({
  algoId,
  name,
  status,
  isEditing,
  onEdit,
  onDelete,
}: {
  algoId: string;
  name: string;
  status: string;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon-sm"
        render={<Link href="/algorithms" />}
        nativeButton={false}
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      </div>
      <Badge variant={STATUS_COLORS[status] ?? "secondary"}>
        {STATUS_LABELS[status] ?? status}
      </Badge>
      {!isEditing && (
        <>
          <Button
            variant="ghost"
            size="sm"
            render={<Link href={`/algorithms/${algoId}/validate`} />}
            nativeButton={false}
            title="Open validation grid"
          >
            <Grid3X3 className="mr-1.5 h-3.5 w-3.5" /> Validate
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit algorithm">
            <Pencil className="h-4 w-4" />
          </Button>
        </>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onDelete}>
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

export function DeleteAlgoDialog({
  name,
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Delete Algorithm</DialogTitle>
          <DialogDescription>Delete &ldquo;{name}&rdquo;? This cannot be undone.</DialogDescription>
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

export function RerunPrompt({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
      <span className="text-sm">Rules updated — re-run backtest?</span>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
