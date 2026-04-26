"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ENTRY_TYPE_LABELS } from "@/lib/constants/journal";
import { journalEntryTypes } from "@/lib/validators/journal";
import type { JournalEmotion, JournalEntryType } from "@/types/journal";
import { EmotionPicker } from "./emotion-picker";
import { StarRating } from "./star-rating";
import { TradeLinker } from "./trade-linker";

const entryTypeDescriptions: Record<string, string> = {
  "pre-market": "What are you watching today? What's your plan?",
  reflection: "How did a trade go? What were you thinking and feeling?",
  review: "Look back at your recent performance and identify patterns.",
  lesson: "What did you learn that you want to remember?",
  "strategy-idea": "Describe a new approach you want to try.",
};

export interface FormFieldsProps {
  form: {
    title: string;
    content: string;
    emotion: JournalEmotion;
    self_rating: number | null;
    tags: string[];
    entry_type: JournalEntryType | "";
    linked_trade_ids: string[];
  };
  errors: Record<string, string>;
  tagInput: string;
  setTagInput: (v: string) => void;
  updateField: (field: string, value: unknown) => void;
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
}

export function EntryTypeField({
  form,
  errors,
  updateField,
}: Pick<FormFieldsProps, "form" | "errors" | "updateField">) {
  return (
    <div className="space-y-1.5">
      <Label>What kind of entry is this?</Label>
      <Select value={form.entry_type} onValueChange={(v) => updateField("entry_type", v)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select type">
            {form.entry_type ? (ENTRY_TYPE_LABELS[form.entry_type] ?? form.entry_type) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {journalEntryTypes.map((t) => (
            <SelectItem key={t} value={t}>
              {ENTRY_TYPE_LABELS[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errors.entry_type && <p className="text-xs text-destructive">{errors.entry_type}</p>}
      {form.entry_type && (
        <p className="text-xs text-muted-foreground">{entryTypeDescriptions[form.entry_type]}</p>
      )}
    </div>
  );
}

export function ContentFields({
  form,
  errors,
  updateField,
}: Pick<FormFieldsProps, "form" | "errors" | "updateField">) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          placeholder="What's on your mind today?"
          className="text-lg"
          value={form.title}
          onChange={(e) => updateField("title", e.target.value)}
        />
        {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="content">Your thoughts</Label>
        <Textarea
          id="content"
          placeholder="What happened? What were you thinking? What would you do differently next time?"
          rows={8}
          value={form.content}
          onChange={(e) => updateField("content", e.target.value)}
        />
        {errors.content && <p className="text-xs text-destructive">{errors.content}</p>}
      </div>
    </>
  );
}

export function TagsField({
  form,
  tagInput,
  setTagInput,
  addTag,
  removeTag,
}: Pick<FormFieldsProps, "form" | "tagInput" | "setTagInput" | "addTag" | "removeTag">) {
  return (
    <div className="space-y-1.5">
      <Label>Tags (optional)</Label>
      <div className="flex gap-2">
        <Input
          placeholder="Add a tag and press Enter"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag(tagInput);
            }
          }}
        />
      </div>
      {form.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {form.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 text-xs">
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="cursor-pointer">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function MoodAndRatingFields({
  form,
  updateField,
}: Pick<FormFieldsProps, "form" | "updateField">) {
  return (
    <>
      <div className="space-y-1.5">
        <Label>How are you feeling about your trading?</Label>
        <EmotionPicker value={form.emotion} onChange={(v) => updateField("emotion", v)} />
      </div>
      <div className="space-y-1.5">
        <Label>How well did you follow your plan?</Label>
        <StarRating value={form.self_rating} onChange={(v) => updateField("self_rating", v)} />
        <p className="text-xs text-muted-foreground">
          1 = didn&apos;t follow it at all, 5 = stuck to it perfectly
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>Link related trades (optional)</Label>
        <TradeLinker
          value={form.linked_trade_ids}
          onChange={(v) => updateField("linked_trade_ids", v)}
        />
      </div>
    </>
  );
}
