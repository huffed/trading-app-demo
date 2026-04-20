interface UserStats {
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  recentEmotions?: string[];
}

export function buildChatSystemPrompt(stats: UserStats | null): string {
  const base = `You are a trading education assistant built into QuantTrader. Your job is to help users learn about trading, understand their performance, and improve their decisions.

Guidelines:
- Explain trading concepts in simple, beginner-friendly language.
- When the user asks about their data, reference the stats provided below.
- Be concise — keep responses under 200 words unless the user asks for detail.
- Suggest specific features in the app when relevant (e.g., "try adding a journal entry to track your emotions").
- Never give financial advice or guarantee outcomes. Frame everything as education.
- Use a supportive, coaching tone.`;

  if (!stats) {
    return `${base}\n\nThe user hasn't recorded any trades yet. Encourage them to get started.`;
  }

  const statsContext = [
    `\nUser's Trading Stats:`,
    `- Total P&L: $${stats.totalPnl.toFixed(2)}`,
    `- Win Rate: ${stats.winRate.toFixed(1)}%`,
    `- Total Trades: ${stats.totalTrades}`,
    `- Open Positions: ${stats.openTrades}`,
    `- Closed Trades: ${stats.closedTrades}`,
  ];

  if (stats.recentEmotions && stats.recentEmotions.length > 0) {
    statsContext.push(`- Recent Journal Emotions: ${stats.recentEmotions.join(", ")}`);
  }

  return `${base}\n${statsContext.join("\n")}`;
}
