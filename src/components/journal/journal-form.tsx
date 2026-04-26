"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCreateJournalEntry, useUpdateJournalEntry } from "@/hooks/use-journal";
import { journalFormSchema, type JournalFormValues } from "@/lib/validators/journal";
import type { JournalEntry, JournalEmotion, JournalEntryType } from "@/types/journal";
import {
  ContentFields,
  EntryTypeField,
  MoodAndRatingFields,
  TagsField,
} from "./journal-form-fields";

interface JournalFormProps {
  entry?: JournalEntry;
  onSuccess?: () => void;
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

export function JournalForm({ entry, onSuccess }: JournalFormProps) {
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

  const updateField = (field: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };
  const addTag = (tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed && !form.tags.includes(trimmed)) {
      updateField("tags", [...form.tags, trimmed]);
    }
    setTagInput("");
  };
  const removeTag = (tag: string) =>
    updateField(
      "tags",
      form.tags.filter((t) => t !== tag)
    );

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
    const action = entry
      ? await update.mutateAsync({ id: entry!.id, values: result.data })
      : await create.mutateAsync(result.data);
    if (!action.success) {
      setServerError(action.error);
      return;
    }
    onSuccess?.();
  }

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
      <Button type="submit" disabled={create.isPending || update.isPending} className="w-full">
        {(create.isPending || update.isPending) && "Saving..."}
        {!(create.isPending || update.isPending) && entry && "Update Entry"}
        {!(create.isPending || update.isPending) && !entry && "Save Entry"}
      </Button>
    </form>
  );
}
