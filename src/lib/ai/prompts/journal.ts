import type { JournalEntry } from "@/types/journal";
import type { Trade } from "@/types/trade";

const SYSTEM_PROMPT = `You are an AI trading journal coach built into QuantTrader. Your role is to help users learn and improve their trading by analyzing their journal entries.

Key principles:
- The user may be a complete beginner. Explain trading concepts in simple terms when relevant.
- Be encouraging but honest. Celebrate good decisions, gently flag mistakes.
- Focus on the process (discipline, risk management, emotional control), not just outcomes.
- Keep your analysis concise and actionable — no fluff.

Structure your response with these sections:
**Summary** — 1-2 sentence overview of the entry.
**What Went Well** — Positive aspects of their decisions, mindset, or process.
**What to Improve** — Areas for growth, mistakes to learn from, or risks to watch.
**Emotional Pattern** — What their reported emotion suggests about their trading mindset.
**Actionable Tip** — One specific, practical thing they can do next time.

If trade data is provided, reference specific numbers (entry/exit prices, P&L, win/loss) in your analysis. If no trades are linked, focus on the journal content and emotions.`;

function formatTrade(trade: Trade, index: number): string {
  const lines = [
    `Trade ${index + 1}: ${trade.symbol} (${trade.side}, ${trade.asset_class})`,
    `  Status: ${trade.status}`,
    `  Entry: $${trade.entry_price} on ${new Date(trade.entry_date).toLocaleDateString()}`,
  ];

  if (trade.exit_price != null) {
    lines.push(`  Exit: $${trade.exit_price}`);
  }
  if (trade.exit_date) {
    lines.push(`  Exit date: ${new Date(trade.exit_date).toLocaleDateString()}`);
  }
  if (trade.realized_pnl != null) {
    const sign = trade.realized_pnl >= 0 ? "+" : "";
    lines.push(`  P&L: ${sign}$${trade.realized_pnl.toFixed(2)}`);
  }
  if (trade.strategy) {
    lines.push(`  Strategy: ${trade.strategy}`);
  }

  return lines.join("\n");
}

export function buildJournalAnalysisPrompt(
  entry: JournalEntry,
  trades: Trade[]
): { system: string; userMessage: string } {
  const parts = [
    `Journal Entry: "${entry.title}"`,
    `Type: ${entry.entry_type}`,
    `Emotion: ${entry.emotion}`,
  ];

  if (entry.self_rating != null) {
    parts.push(`Self-rating: ${entry.self_rating}/5`);
  }
  if (entry.tags.length > 0) {
    parts.push(`Tags: ${entry.tags.join(", ")}`);
  }

  parts.push("", "Content:", entry.content || "(no content written)");

  if (trades.length > 0) {
    parts.push("", "Linked Trades:");
    trades.forEach((t, i) => parts.push(formatTrade(t, i)));
  } else {
    parts.push("", "No trades linked to this entry.");
  }

  return {
    system: SYSTEM_PROMPT,
    userMessage: parts.join("\n"),
  };
}
