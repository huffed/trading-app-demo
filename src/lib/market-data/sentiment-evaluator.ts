import type { SentimentCondition } from "@/types/algorithm";
import type { SentimentSnapshot } from "./news-sentiment";

function getMetricValue(snapshot: SentimentSnapshot, metric: string): number {
  switch (metric) {
    case "overall_sentiment": return snapshot.aggregate.avg_sentiment;
    case "article_count": return snapshot.aggregate.article_count;
    case "topic_buzz": {
      // topic_buzz = proportion of articles that are bullish
      const total = snapshot.aggregate.article_count;
      return total > 0 ? snapshot.aggregate.bullish_count / total : 0;
    }
    default: return 0;
  }
}

export function evaluateSentimentCondition(
  condition: SentimentCondition,
  snapshot: SentimentSnapshot
): boolean {
  const value = getMetricValue(snapshot, condition.metric);

  switch (condition.operator) {
    case "above": return value > condition.threshold;
    case "below": return value < condition.threshold;
    case "spike_above": return value > condition.threshold;
    case "spike_below": return value < condition.threshold;
    default: return false;
  }
}

export function evaluateAllSentimentConditions(
  conditions: SentimentCondition[],
  snapshot: SentimentSnapshot
): { allMet: boolean; results: { condition: SentimentCondition; met: boolean; value: number }[] } {
  const results = conditions.map((c) => ({
    condition: c,
    met: evaluateSentimentCondition(c, snapshot),
    value: getMetricValue(snapshot, c.metric),
  }));
  return { allMet: results.every((r) => r.met), results };
}
