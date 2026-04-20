import type { JournalEntry } from "@/types/journal";
import type { Trade } from "@/types/trade";
import { getAnthropicClient } from "./client";
import { buildJournalAnalysisPrompt } from "./prompts/journal";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;

export async function analyzeJournalEntry(
  entry: JournalEntry,
  trades: Trade[]
): Promise<string> {
  const client = getAnthropicClient();
  const { system, userMessage } = buildJournalAnalysisPrompt(entry, trades);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in AI response");
  }

  return textBlock.text;
}
