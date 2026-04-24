/**
 * Centralized label maps for journal enum values.
 * Source of truth for display strings — never define these inline in components.
 * Must stay in sync with types/journal.ts (JournalEntryType, JournalEmotion).
 */

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  "pre-market": "Pre-Market Plan",
  reflection: "Trade Reflection",
  review: "Daily/Weekly Review",
  lesson: "Lesson Learned",
  "strategy-idea": "Strategy Idea",
};

/** Shorter labels for filters, badges, and compact views. */
export const ENTRY_TYPE_SHORT_LABELS: Record<string, string> = {
  "pre-market": "Pre-Market",
  reflection: "Reflection",
  review: "Review",
  lesson: "Lesson",
  "strategy-idea": "Strategy",
};

export const EMOTION_LABELS: Record<string, string> = {
  confident: "Confident",
  disciplined: "Disciplined",
  calm: "Calm",
  neutral: "Neutral",
  anxious: "Anxious",
  fearful: "Fearful",
  greedy: "Greedy",
  impulsive: "Impulsive",
  frustrated: "Frustrated",
};
