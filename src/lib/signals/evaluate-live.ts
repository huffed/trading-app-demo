/**
 * Live signal evaluation — checks if an algorithm's sentiment conditions
 * are currently met for a given ticker.
 *
 * Flow:
 *   1. Extract sentiment conditions from algorithm rules
 *   2. Check Supabase cache for recent sentiment data (6h TTL)
 *   3. If cache miss, fetch from Alpha Vantage News Sentiment API
 *   4. Run mechanical threshold checks (sentiment score above/below/spike)
 *   5. Send data to LLM for qualitative narrative/catalyst assessment
 *   6. Return combined signal (buy/hold/no_signal) with confidence
 *
 * Note: This only evaluates SENTIMENT conditions. Technical conditions
 * are evaluated in the backtest engine against price data.
 */
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildSignalPrompt } from "@/lib/ai/prompts/signal";
import { fetchNewsSentiment } from "@/lib/market-data/news-sentiment";
import { getCachedSentiment, saveSentimentToCache } from "@/lib/market-data/sentiment-cache";
import { evaluateAllSentimentConditions } from "@/lib/market-data/sentiment-evaluator";
import {
  isSentimentCondition,
  type AlgorithmRules,
  type SentimentCondition,
} from "@/types/algorithm";

export interface SignalResult {
  signal: "buy" | "hold" | "no_signal";
  confidence: number;
  reasoning: string;
  conditions_evaluated: {
    metric: string;
    operator: string;
    threshold: number;
    met: boolean;
    value: number;
  }[];
  articles_count: number;
  avg_sentiment: number;
}

export async function evaluateLiveSignal(
  rules: AlgorithmRules,
  ticker: string,
  algorithmDescription: string
): Promise<SignalResult> {
  const sentimentConditions = [
    ...rules.entry_conditions.filter(isSentimentCondition),
    ...rules.exit_conditions.filter(isSentimentCondition),
  ] as SentimentCondition[];

  if (sentimentConditions.length === 0) {
    return {
      signal: "no_signal",
      confidence: 0,
      reasoning: "This algorithm has no sentiment conditions to evaluate.",
      conditions_evaluated: [],
      articles_count: 0,
      avg_sentiment: 0,
    };
  }

  // Collect topics and check cache before hitting API
  const topics = [...new Set(sentimentConditions.flatMap((c) => c.topics ?? []))];
  const topicsArg = topics.length > 0 ? topics : undefined;
  let snapshot = await getCachedSentiment(ticker, topicsArg);
  if (!snapshot) {
    snapshot = await fetchNewsSentiment(ticker, topicsArg);
    // Best-effort: cache failure shouldn't block signal evaluation
    await saveSentimentToCache(snapshot, topicsArg).catch((e) =>
      console.warn(
        `[sentiment-cache] Failed to cache ${ticker}:`,
        e instanceof Error ? e.message : e
      )
    );
  }

  // Mechanical evaluation
  const { results } = evaluateAllSentimentConditions(sentimentConditions, snapshot);
  const conditionsEvaluated = results.map((r) => ({
    metric: r.condition.metric,
    operator: r.condition.operator,
    threshold: r.condition.threshold,
    met: r.met,
    value: Number(r.value.toFixed(4)),
  }));

  // LLM qualitative assessment
  const { system, userMessage } = buildSignalPrompt(
    snapshot,
    sentimentConditions,
    algorithmDescription
  );
  const client = getAIClient();
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    max_tokens: 512,
  });

  const text = res.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(text) as { signal?: string; confidence?: number; reasoning?: string };
    return {
      signal: (["buy", "hold", "no_signal"].includes(parsed.signal ?? "")
        ? parsed.signal
        : "no_signal") as SignalResult["signal"],
      confidence: Math.min(100, Math.max(0, parsed.confidence ?? 0)),
      reasoning: parsed.reasoning ?? "Unable to assess.",
      conditions_evaluated: conditionsEvaluated,
      articles_count: snapshot.aggregate.article_count,
      avg_sentiment: snapshot.aggregate.avg_sentiment,
    };
  } catch {
    return {
      signal: "no_signal",
      confidence: 0,
      reasoning: "Failed to parse AI assessment.",
      conditions_evaluated: conditionsEvaluated,
      articles_count: snapshot.aggregate.article_count,
      avg_sentiment: snapshot.aggregate.avg_sentiment,
    };
  }
}
