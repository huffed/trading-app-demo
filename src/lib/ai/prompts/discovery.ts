import { isTechnicalCondition, isSentimentCondition, type Algorithm } from "@/types/algorithm";

const DISCOVERY_SYSTEM_PROMPT = `You are a stock discovery engine for a trading platform. Given a user's trading profile and algorithm strategy, suggest stocks they should be monitoring.

Output ONLY valid JSON — no explanation, no markdown.

Your response MUST be a JSON object with a "suggestions" key containing an array:
{
  "suggestions": [
    {
      "ticker": "SYMBOL",
      "name": "Company Name",
      "sector": "Sector or Theme",
      "reasoning": "1-2 sentence explanation of why this matches the user's profile"
    }
  ]
}

RULES:
- Suggest 5-10 US-listed stocks (NYSE, NASDAQ)
- Use standard ticker symbols (e.g., AAPL, MSFT, IONQ)
- DO NOT suggest any ticker listed in the ALREADY WATCHING section
- Focus on the same sectors, themes, and market cap range as the user's history
- Include a mix of:
  - Direct competitors or peers of stocks they already trade
  - Adjacent sector plays (e.g., quantum computing → AI infrastructure, space → defense)
  - Smaller or lesser-known picks in the same theme
- Each reasoning should explain the specific connection to the user's trading style
- Prefer liquid stocks with reasonable trading volume
- Match the user's apparent risk level and price range`;

function summarizeConditions(algo: Algorithm): string {
  const parts: string[] = [];
  const techEntry = algo.rules.entry_conditions.filter(isTechnicalCondition);
  const sentEntry = algo.rules.entry_conditions.filter(isSentimentCondition);

  if (techEntry.length > 0) {
    parts.push("Technical entry: " + techEntry.map((c) =>
      `${c.indicator} ${c.operator} ${c.value}`
    ).join(", "));
  }
  if (sentEntry.length > 0) {
    parts.push("Sentiment entry: " + sentEntry.map((c) =>
      `${c.metric} ${c.operator} ${c.threshold}` + (c.topics?.length ? ` (topics: ${c.topics.join(", ")})` : "")
    ).join(", "));
  }

  const { stop_loss, take_profit, position_sizing } = algo.rules;
  if (stop_loss) parts.push(`Stop loss: ${stop_loss.value}%`);
  if (take_profit) parts.push(`Take profit: ${take_profit.value}%`);
  if (position_sizing) parts.push(`Position size: ${position_sizing.value}% of capital`);

  return parts.join("\n");
}

export function buildDiscoveryPrompt(
  algo: Algorithm,
  existingTickers: string[]
): { system: string; userMessage: string } {
  const sections: string[] = [
    `Algorithm: ${algo.name}`,
    `Asset class: ${algo.asset_class}`,
    `Risk level: ${algo.risk_level}`,
    `Time horizon: ${algo.time_horizon}`,
    `Capital: $${algo.capital.toLocaleString()}`,
  ];

  if (algo.description) {
    sections.push(`\nStrategy description:\n${algo.description}`);
  }

  const conditions = summarizeConditions(algo);
  if (conditions) {
    sections.push(`\nTrading rules:\n${conditions}`);
  }

  if (algo.user_hints) {
    sections.push(`\nUser's trade history analysis:\n${algo.user_hints}`);
  }

  if (existingTickers.length > 0) {
    sections.push(`\nALREADY WATCHING (do NOT suggest these):\n${existingTickers.join(", ")}`);
  } else {
    sections.push("\nALREADY WATCHING: none");
  }

  return { system: DISCOVERY_SYSTEM_PROMPT, userMessage: sections.join("\n") };
}

const ANALYSIS_SYSTEM_PROMPT = `You are a trading analyst. Given an algorithm's strategy and a set of tickers with their backtest results, write a brief analysis for each ticker.

Output ONLY valid JSON — no explanation, no markdown.

Your response MUST be a JSON object with an "analyses" key:
{
  "analyses": [
    {
      "ticker": "SYMBOL",
      "analysis": "2-3 sentence analysis"
    }
  ]
}

For each ticker:
- Reference current market trends, sector momentum, and news catalysts relevant to that stock
- Explain WHY the algorithm performed well or poorly on it (connect the strategy's rules to the stock's behavior)
- For profitable tickers: highlight what makes them a good fit and any risks
- For unprofitable tickers: explain what went wrong — was the stock too stable for a dip-buying strategy? In a sustained downtrend? Wrong sector dynamics?
- Be specific — mention the stock's industry, recent performance trajectory, and how it interacts with the algorithm's entry/exit rules
- Keep each analysis to 2-3 sentences`;

export interface TickerBacktestSummary {
  ticker: string;
  name: string;
  totalReturn: number;
  winRate: number;
  totalTrades: number;
  profitable: boolean;
  failed: boolean;
}

export function buildAnalysisPrompt(
  algo: Algorithm,
  results: TickerBacktestSummary[]
): { system: string; userMessage: string } {
  const sections: string[] = [
    `Algorithm: ${algo.name}`,
    `Strategy: ${algo.description ?? "N/A"}`,
  ];

  const conditions = summarizeConditions(algo);
  if (conditions) sections.push(`Rules:\n${conditions}`);

  sections.push("\nBacktest results per ticker:");
  for (const r of results) {
    if (r.failed) {
      sections.push(`- ${r.ticker} (${r.name}): backtest failed`);
    } else {
      sections.push(`- ${r.ticker} (${r.name}): return ${r.totalReturn >= 0 ? "+" : ""}${r.totalReturn.toFixed(1)}%, win rate ${r.winRate.toFixed(0)}%, ${r.totalTrades} trades`);
    }
  }

  return { system: ANALYSIS_SYSTEM_PROMPT, userMessage: sections.join("\n") };
}
