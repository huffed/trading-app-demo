"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EMOTION_LABELS, ENTRY_TYPE_SHORT_LABELS } from "@/lib/constants/journal";
import { useJournalFilterStore } from "@/stores/journal-filter-store";
import type { JournalEmotion, JournalEntryType } from "@/types/journal";

function EmotionSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: JournalEmotion | undefined) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "all" ? undefined : (v as JournalEmotion))}
    >
      <SelectTrigger className="h-8 w-32">
        <SelectValue placeholder="Emotion" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Emotions</SelectItem>
        {Object.entries(EMOTION_LABELS).map(([val, label]) => (
          <SelectItem key={val} value={val}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EntryTypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: JournalEntryType | undefined) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "all" ? undefined : (v as JournalEntryType))}
    >
      <SelectTrigger className="h-8 w-32">
        <SelectValue placeholder="Type" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Types</SelectItem>
        {Object.entries(ENTRY_TYPE_SHORT_LABELS).map(([val, label]) => (
          <SelectItem key={val} value={val}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function JournalFilters() {
  const { filters, setFilter, resetFilters } = useJournalFilterStore();

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Search entries..."
        className="h-8 w-40"
        value={filters.search ?? ""}
        onChange={(e) => setFilter("search", e.target.value || undefined)}
      />
      <EmotionSelect value={filters.emotion ?? "all"} onChange={(v) => setFilter("emotion", v)} />
      <EntryTypeSelect
        value={filters.entry_type ?? "all"}
        onChange={(v) => setFilter("entry_type", v)}
      />
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          <X className="mr-1 h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
