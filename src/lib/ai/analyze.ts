import type { JournalEntry } from "@/types/journal";
import type { Trade } from "@/types/trade";
import { AI_MODEL, getAIClient } from "./client";
import { buildJournalAnalysisPrompt } from "./prompts/journal";

export async function analyzeJournalEntry(
  entry: JournalEntry,
  trades: Trade[]
): Promise<string> {
  const client = getAIClient();
  const { system, userMessage } = buildJournalAnalysisPrompt(entry, trades);

  const response = await client.models.generateContent({
    model: AI_MODEL,
    contents: userMessage,
    config: {
      systemInstruction: system,
      maxOutputTokens: 1024,
    },
  });

  const text = response.text;
  if (!text) throw new Error("No text content in AI response");

  return text;
}
