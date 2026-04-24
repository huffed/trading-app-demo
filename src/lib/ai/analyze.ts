import type { JournalEntry } from "@/types/journal";
import type { Trade } from "@/types/trade";
import { AI_MODEL, getAIClient } from "./client";
import { buildJournalAnalysisPrompt } from "./prompts/journal";

export async function analyzeJournalEntry(entry: JournalEntry, trades: Trade[]): Promise<string> {
  const client = getAIClient();
  const { system, userMessage } = buildJournalAnalysisPrompt(entry, trades);

  const response = await client.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("No text content in AI response");

  return text;
}
