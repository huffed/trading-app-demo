import { createClient } from "@/lib/supabase/server";
import type { SentimentSnapshot } from "./news-sentiment";

const CACHE_MAX_AGE_HOURS = 6;

export async function getCachedSentiment(
  ticker: string,
  topics?: string[]
): Promise<SentimentSnapshot | null> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - CACHE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  const query = supabase
    .from("sentiment_cache")
    .select("*")
    .eq("ticker", ticker)
    .eq("topics", `{${(topics ?? []).join(",")}}`)
    .gte("fetched_at", cutoff)
    .order("fetched_at", { ascending: false })
    .limit(1);

  const { data } = await query;
  if (!data || data.length === 0) {
    return null;
  }

  const row = data[0];
  return {
    ticker: row.ticker,
    fetched_at: row.fetched_at,
    articles: row.articles as SentimentSnapshot["articles"],
    aggregate: {
      avg_sentiment: Number(row.avg_sentiment),
      article_count: row.article_count,
      bullish_count: row.bullish_count,
      bearish_count: row.bearish_count,
      topic_distribution: row.topic_distribution as Record<string, number>,
    },
  };
}

export async function saveSentimentToCache(
  snapshot: SentimentSnapshot,
  topics?: string[]
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return;
  }

  await supabase.from("sentiment_cache").upsert({
    user_id: user.id,
    ticker: snapshot.ticker,
    topics: topics ?? [],
    fetched_at: snapshot.fetched_at,
    avg_sentiment: snapshot.aggregate.avg_sentiment,
    article_count: snapshot.aggregate.article_count,
    bullish_count: snapshot.aggregate.bullish_count,
    bearish_count: snapshot.aggregate.bearish_count,
    articles: snapshot.articles,
    topic_distribution: snapshot.aggregate.topic_distribution,
  });
}
