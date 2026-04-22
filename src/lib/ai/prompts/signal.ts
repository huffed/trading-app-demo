import type { SentimentSnapshot } from "@/lib/market-data/news-sentiment";
import type { SentimentCondition } from "@/types/algorithm";

const SIGNAL_SYSTEM_PROMPT = `You are a trading signal analyst. Analyze the provided news articles and market sentiment data to assess whether a trading opportunity exists.

Output ONLY valid JSON — no explanation, no markdown.

Schema:
{
  "signal": "buy" | "hold" | "no_signal",
  "confidence": 0-100,
  "reasoning": "1-3 sentence explanation referencing specific articles or data points"
}

Guidelines:
- "buy" = strong evidence the narrative/catalyst is forming, sentiment supports entry
- "hold" = some positive signals but not enough conviction, wait for more data
- "no_signal" = no meaningful catalyst detected, or sentiment is neutral/negative
- Confidence 80+ = very clear signal with multiple confirming articles
- Confidence 50-80 = moderate signal, some supporting evidence
- Confidence <50 = weak signal, mostly noise
- Be specific — reference actual headlines and sentiment scores
- Never guarantee outcomes — frame as probability assessment`;

export function buildSignalPrompt(
  snapshot: SentimentSnapshot,
  conditions: SentimentCondition[],
  algorithmDescription: string
): { system: string; userMessage: string } {
  const topArticles = snapshot.articles.slice(0, 10).map((a, i) =>
    `${i + 1}. "${a.title}" (sentiment: ${a.overall_sentiment.toFixed(3)}, source: ${a.source})`
  );

  const conditionsSummary = conditions.map((c) =>
    `- ${c.metric} ${c.operator} ${c.threshold} for ${c.topics?.join(", ") ?? c.tickers?.join(", ") ?? "general"}`
  );

  const userMessage = [
    `Ticker: ${snapshot.ticker}`,
    `Aggregate sentiment: ${snapshot.aggregate.avg_sentiment.toFixed(3)}`,
    `Articles: ${snapshot.aggregate.article_count} total, ${snapshot.aggregate.bullish_count} bullish, ${snapshot.aggregate.bearish_count} bearish`,
    "",
    "Algorithm conditions to evaluate:",
    ...conditionsSummary,
    "",
    "Algorithm strategy:",
    algorithmDescription.slice(0, 500),
    "",
    "Recent articles:",
    ...topArticles,
  ].join("\n");

  return { system: SIGNAL_SYSTEM_PROMPT, userMessage };
}
