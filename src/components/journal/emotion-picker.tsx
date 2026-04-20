"use client";

import { cn } from "@/lib/utils";
import type { JournalEmotion } from "@/types/journal";

const emotions: {
  value: JournalEmotion;
  label: string;
  emoji: string;
  group: "positive" | "neutral" | "negative";
}[] = [
  { value: "confident", label: "Confident", emoji: "💪", group: "positive" },
  { value: "disciplined", label: "Disciplined", emoji: "🎯", group: "positive" },
  { value: "calm", label: "Calm", emoji: "😌", group: "positive" },
  { value: "neutral", label: "Neutral", emoji: "😐", group: "neutral" },
  { value: "anxious", label: "Anxious", emoji: "😰", group: "negative" },
  { value: "fearful", label: "Fearful", emoji: "😨", group: "negative" },
  { value: "greedy", label: "Greedy", emoji: "🤑", group: "negative" },
  { value: "impulsive", label: "Impulsive", emoji: "⚡", group: "negative" },
  { value: "frustrated", label: "Frustrated", emoji: "😤", group: "negative" },
];

const groupColors = {
  positive: "border-[var(--profit)] bg-[var(--profit)]/10 text-[var(--profit)]",
  neutral: "border-primary bg-primary/10 text-primary",
  negative: "border-[var(--loss)] bg-[var(--loss)]/10 text-[var(--loss)]",
};

interface EmotionPickerProps {
  value: JournalEmotion;
  onChange: (emotion: JournalEmotion) => void;
  readOnly?: boolean;
}

export function EmotionPicker({ value, onChange, readOnly }: EmotionPickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {emotions.map((e) => {
        const isSelected = value === e.value;
        return (
          <button
            key={e.value}
            type="button"
            disabled={readOnly}
            onClick={() => onChange(e.value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
              isSelected
                ? groupColors[e.group]
                : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
              readOnly && "cursor-default"
            )}
          >
            <span>{e.emoji}</span>
            <span>{e.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function getEmotionDisplay(emotion: JournalEmotion) {
  return emotions.find((e) => e.value === emotion) ?? emotions[3];
}
