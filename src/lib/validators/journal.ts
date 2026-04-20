import { z } from "zod";

export const journalEmotions = [
  "confident",
  "disciplined",
  "calm",
  "neutral",
  "anxious",
  "fearful",
  "greedy",
  "impulsive",
  "frustrated",
] as const;

export const journalEntryTypes = [
  "pre-market",
  "reflection",
  "review",
  "lesson",
  "strategy-idea",
] as const;

export const journalFormSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  content: z.string().max(10000).default(""),
  emotion: z.enum(journalEmotions).default("neutral"),
  self_rating: z.coerce
    .number()
    .min(1)
    .max(5)
    .nullable()
    .optional()
    .or(z.literal("")),
  tags: z.array(z.string()).default([]),
  entry_type: z.enum(journalEntryTypes, { message: "Please select an entry type" }),
  linked_trade_ids: z.array(z.string().uuid()).default([]),
});

export type JournalFormValues = z.infer<typeof journalFormSchema>;
