export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  published_at: string;
  summary: string;
  overall_sentiment: number;
  ticker_sentiments: { ticker: string; relevance: number; sentiment: number }[];
  topics: string[];
}

export interface SentimentSnapshot {
  ticker: string;
  fetched_at: string;
  articles: NewsArticle[];
  aggregate: {
    avg_sentiment: number;
    article_count: number;
    bullish_count: number;
    bearish_count: number;
    topic_distribution: Record<string, number>;
  };
}

interface AVArticle {
  title: string;
  url: string;
  time_published: string;
  source: string;
  summary: string;
  overall_sentiment_score: number;
  overall_sentiment_label: string;
  ticker_sentiment: { ticker: string; relevance_score: string; ticker_sentiment_score: string }[];
  topics: { topic: string }[];
}

interface AVResponse {
  feed?: AVArticle[];
  Information?: string;
  Note?: string;
}

const BASE_URL = "https://www.alphavantage.co/query";

// Simple in-memory cache — sentiment doesn't change intra-day
const cache = new Map<string, { snapshot: SentimentSnapshot; expiry: number }>();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

function normalizeArticle(a: AVArticle): NewsArticle {
  return {
    title: a.title,
    url: a.url,
    source: a.source,
    published_at: a.time_published,
    summary: a.summary,
    overall_sentiment: a.overall_sentiment_score,
    ticker_sentiments: (a.ticker_sentiment ?? []).map((t) => ({
      ticker: t.ticker,
      relevance: parseFloat(t.relevance_score),
      sentiment: parseFloat(t.ticker_sentiment_score),
    })),
    topics: (a.topics ?? []).map((t) => t.topic),
  };
}

function buildAggregate(articles: NewsArticle[]): SentimentSnapshot["aggregate"] {
  const sentiments = articles.map((a) => a.overall_sentiment);
  const avg = sentiments.length > 0 ? sentiments.reduce((s, v) => s + v, 0) / sentiments.length : 0;
  const topicCounts: Record<string, number> = {};
  for (const a of articles) {
    for (const t of a.topics) {
      topicCounts[t] = (topicCounts[t] ?? 0) + 1;
    }
  }
  return {
    avg_sentiment: Number(avg.toFixed(4)),
    article_count: articles.length,
    bullish_count: sentiments.filter((s) => s > 0.15).length,
    bearish_count: sentiments.filter((s) => s < -0.15).length,
    topic_distribution: topicCounts,
  };
}

export async function fetchNewsSentiment(
  ticker: string,
  topics?: string[]
): Promise<SentimentSnapshot> {
  const cacheKey = `${ticker}:${topics?.join(",") ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) { return cached.snapshot; }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) { throw new Error("ALPHA_VANTAGE_API_KEY is not set"); }

  const params = new URLSearchParams({
    function: "NEWS_SENTIMENT",
    tickers: ticker,
    apikey: apiKey,
  });
  if (topics?.length) { params.set("topics", topics.join(",")); }

  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) { throw new Error(`News sentiment request failed: ${res.status}`); }

  const data = (await res.json()) as AVResponse;
  if (data.Information) { throw new Error("Alpha Vantage API limit reached. Try again later."); }
  if (data.Note) { throw new Error("Alpha Vantage rate limit reached (25 requests/day)"); }
  if (!data.feed) { throw new Error("No news data returned"); }

  const articles = data.feed.map(normalizeArticle);
  const snapshot: SentimentSnapshot = {
    ticker,
    fetched_at: new Date().toISOString(),
    articles,
    aggregate: buildAggregate(articles),
  };
  cache.set(cacheKey, { snapshot, expiry: Date.now() + CACHE_TTL });
  return snapshot;
}
