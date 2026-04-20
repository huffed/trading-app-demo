"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  useCreateJournalEntry,
  useUpdateJournalEntry,
} from "@/hooks/use-journal";
import {
  journalFormSchema,
  journalEntryTypes,
  type JournalFormValues,
} from "@/lib/validators/journal";
import type { JournalEntry, JournalEmotion, JournalEntryType } from "@/types/journal";
import { EmotionPicker } from "./emotion-picker";
import { StarRating } from "./star-rating";
import { TradeLinker } from "./trade-linker";

interface JournalFormProps {
  entry?: JournalEntry;
  onSuccess?: () => void;
}

const entryTypeLabels: Record<string, string> = {
  "pre-market": "Pre-Market Plan",
  reflection: "Trade Reflection",
  review: "Daily/Weekly Review",
  lesson: "Lesson Learned",
  "strategy-idea": "Strategy Idea",
};

const entryTypeDescriptions: Record<string, string> = {
  "pre-market": "What are you watching today? What's your plan?",
  reflection: "How did a trade go? What were you thinking and feeling?",
  review: "Look back at your recent performance and identify patterns.",
  lesson: "What did you learn that you want to remember?",
  "strategy-idea": "Describe a new approach you want to try.",
};

interface FormFieldsProps {
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

function EntryTypeField({ form, errors, updateField }: Pick<FormFieldsProps, "form" | "errors" | "updateField">) {
  return (
    <div className="space-y-1.5">
      <Label>What kind of entry is this?</Label>
      <Select
        value={form.entry_type}
        onValueChange={(v) => updateField("entry_type", v)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select type">
            {form.entry_type ? (entryTypeLabels[form.entry_type] ?? form.entry_type) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {journalEntryTypes.map((t) => (
            <SelectItem key={t} value={t}>
              {entryTypeLabels[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errors.entry_type && (
        <p className="text-xs text-destructive">{errors.entry_type}</p>
      )}
      {form.entry_type && (
        <p className="text-xs text-muted-foreground">
          {entryTypeDescriptions[form.entry_type]}
        </p>
      )}
    </div>
  );
}

function ContentFields({ form, errors, updateField }: Pick<FormFieldsProps, "form" | "errors" | "updateField">) {
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
        {errors.title && (
          <p className="text-xs text-destructive">{errors.title}</p>
        )}
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
        {errors.content && (
          <p className="text-xs text-destructive">{errors.content}</p>
        )}
      </div>
    </>
  );
}

function TagsField({ form, tagInput, setTagInput, addTag, removeTag }: Pick<FormFieldsProps, "form" | "tagInput" | "setTagInput" | "addTag" | "removeTag">) {
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
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function parseFormErrors(form: Record<string, unknown>) {
  const parsed = journalFormSchema.safeParse(form);
  if (parsed.success) {
    return { success: true as const, data: parsed.data as JournalFormValues };
  }
  const fieldErrors: Record<string, string> = {};
  const unmappedErrors: string[] = [];
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]?.toString();
    if (key) {
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    } else {
      unmappedErrors.push(issue.message);
    }
  }
  return { success: false as const, fieldErrors, unmappedErrors };
}

function MoodAndRatingFields({ form, updateField }: Pick<FormFieldsProps, "form" | "updateField">) {
  return (
    <>
      <div className="space-y-1.5">
        <Label>How are you feeling about your trading?</Label>
        <EmotionPicker
          value={form.emotion}
          onChange={(v) => updateField("emotion", v)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>How well did you follow your plan?</Label>
        <StarRating
          value={form.self_rating}
          onChange={(v) => updateField("self_rating", v)}
        />
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

export function JournalForm({ entry, onSuccess }: JournalFormProps) {
  const isEdit = !!entry;
  const create = useCreateJournalEntry();
  const update = useUpdateJournalEntry();

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  const [form, setForm] = useState({
    title: entry?.title ?? "",
    content: entry?.content ?? "",
    emotion: (entry?.emotion ?? "neutral") as JournalEmotion,
    self_rating: entry?.self_rating ?? (null as number | null),
    tags: entry?.tags ?? ([] as string[]),
    entry_type: (entry?.entry_type ?? "") as JournalEntryType | "",
    linked_trade_ids: entry?.linked_trade_ids ?? ([] as string[]),
  });

  function updateField(field: string, value: unknown) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function addTag(tag: string) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed && !form.tags.includes(trimmed)) {
      updateField("tags", [...form.tags, trimmed]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    updateField("tags", form.tags.filter((t) => t !== tag));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const result = parseFormErrors(form);
    if (!result.success) {
      setErrors(result.fieldErrors);
      if (result.unmappedErrors.length > 0) {
        setServerError(result.unmappedErrors.join(". "));
      }
      return;
    }

    const action = isEdit
      ? await update.mutateAsync({ id: entry!.id, values: result.data })
      : await create.mutateAsync(result.data);

    if (!action.success) {
      setServerError(action.error);
      return;
    }
    onSuccess?.();
  }

  const isPending = create.isPending || update.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {serverError && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {serverError}
        </div>
      )}
      <EntryTypeField form={form} errors={errors} updateField={updateField} />
      <ContentFields form={form} errors={errors} updateField={updateField} />
      <MoodAndRatingFields form={form} updateField={updateField} />
      <TagsField
        form={form}
        tagInput={tagInput}
        setTagInput={setTagInput}
        addTag={addTag}
        removeTag={removeTag}
      />
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending && "Saving..."}
        {!isPending && isEdit && "Update Entry"}
        {!isPending && !isEdit && "Save Entry"}
      </Button>
    </form>
  );
}
