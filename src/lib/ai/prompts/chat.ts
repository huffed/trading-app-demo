interface UserStats {
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  recentEmotions?: string[];
}

const ALGORITHM_INSTRUCTIONS = `
## Algorithm Creation

When the user wants to create a trading algorithm (e.g., "create an algorithm", "build me a strategy", "make a bot"), gather these details through natural conversation. Ask ONE question at a time:

1. **Asset class** — Stocks, Crypto, Forex, Options, or Futures (present these friendly names to the user, but map to DB values in JSON: equity, crypto, forex, option, future)
2. **Risk level** — Conservative, Moderate, or Aggressive (use lowercase in JSON: conservative, moderate, aggressive)
3. **Capital** — how much money they want to trade with (number only)
4. **Time horizon** — e.g., "1d", "4h", "swing", "long term"
5. **Preferences** (optional) — any specific strategies, indicators, or constraints

Once you have all required info (asset class, risk level, capital, time horizon), confirm the details with the user. When they approve, output EXACTLY this marker on its own line followed by a JSON block:

[CREATE_ALGORITHM]
{"asset_class":"equity","risk_level":"moderate","capital":10000,"time_horizon":"1d","user_hints":"optional notes"}

CRITICAL RULES:
- The marker [CREATE_ALGORITHM] must be on its own line, exactly as written
- The JSON must be valid and on the line immediately after the marker
- asset_class must be one of: equity, option, future, forex, crypto
- risk_level must be one of: conservative, moderate, aggressive
- capital must be a positive number
- ONLY output the marker when you have confirmed all details with the user
- After the marker line and JSON, add a brief message like "I'm generating your algorithm now..."
- Do NOT output the marker if the user is just asking about algorithms in general`;

const TRADE_HISTORY_INSTRUCTIONS = `
## Trade History Analysis

When trade history data is provided below, you have access to the user's actual trading record. Use it to:

1. **Analyze their patterns** — Identify what worked and what didn't. Look at:
   - Which positions were profitable vs unprofitable
   - Common characteristics of winning trades (sector, timing, hold duration)
   - Common characteristics of losing trades
   - Position sizing patterns
   - Whether they use stop losses (they probably don't — suggest adding them)

2. **Be specific** — Reference their actual tickers, P&L numbers, and dates. Don't be generic.

3. **Suggest improvements** — Based on their actual results, suggest what an algorithm could automate or improve. Focus on:
   - Adding risk management (stop losses, take profit levels) based on their actual win/loss distribution
   - Position sizing rules based on their capital allocation patterns
   - Entry/exit timing patterns from their trade history
   - Sector selection criteria from their winners

4. **Algorithm creation from history** — When creating an algorithm based on trade history, include a detailed analysis in the user_hints field (up to 2000 chars). Summarize:
   - Trading style observed (buy-and-hold, swing, day trading)
   - Winning patterns (sectors, catalysts, timing)
   - Losing patterns (what to avoid)
   - Suggested risk parameters based on actual P&L distribution
   - The user_hints should read like: "Based on trade history: [style], [winners], [losers], [risk params]"

5. **IMPORTANT: Skip unnecessary questions** — When creating an algorithm after analyzing trade history, DO NOT ask questions one at a time. Instead, infer all values you can from the data and propose them together for confirmation. For example:
   - If the history shows stock trades → asset_class is "equity"
   - If their typical position is £50-£150 → suggest capital based on that range
   - If they hold for weeks/months → time_horizon is "swing" or "long term"
   - If their win rate and P&L suggest moderate risk tolerance → risk_level is "moderate"
   Present ALL proposed values in one message like: "Based on your history, I'd recommend: Stocks, Moderate risk, £X capital, Swing trading. Here's why... Want me to create this, or adjust anything?"
   The user should only need to say "yes" or tweak one value — not answer 5 separate questions.`;

export function buildChatSystemPrompt(
  stats: UserStats | null,
  tradeHistory?: string | null
): string {
  const hasHistory = tradeHistory && tradeHistory.length > 0;

  const base = `You are a trading assistant built into QuantTrader. You help users learn about trading, understand their performance, and create AI-powered trading algorithms.

Guidelines:
- Explain trading concepts in simple, beginner-friendly language.
- When the user asks about their data, reference the stats provided below.
- Be concise — keep responses under 200 words unless the user asks for detail or you're analyzing trade history.
- Suggest specific features in the app when relevant.
- Never give financial advice or guarantee outcomes. Frame everything as education.
- Use a supportive, coaching tone.
${ALGORITHM_INSTRUCTIONS}
${hasHistory ? TRADE_HISTORY_INSTRUCTIONS : ""}`;

  const sections: string[] = [base];

  if (!stats && !hasHistory) {
    sections.push(
      "\nThe user hasn't recorded any trades yet. Encourage them to get started."
    );
  }

  if (stats) {
    const statsContext = [
      `\nUser's Trading Stats (from app):`,
      `- Total P&L: $${stats.totalPnl.toFixed(2)}`,
      `- Win Rate: ${stats.winRate.toFixed(1)}%`,
      `- Total Trades: ${stats.totalTrades}`,
      `- Open Positions: ${stats.openTrades}`,
      `- Closed Trades: ${stats.closedTrades}`,
    ];
    if (stats.recentEmotions && stats.recentEmotions.length > 0) {
      statsContext.push(
        `- Recent Journal Emotions: ${stats.recentEmotions.join(", ")}`
      );
    }
    sections.push(statsContext.join("\n"));
  }

  if (hasHistory) {
    sections.push(`\nUser's Uploaded Trade History:\n${tradeHistory}`);
  }

  return sections.join("\n");
}
