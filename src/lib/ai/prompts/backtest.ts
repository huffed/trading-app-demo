import type { Algorithm } from "@/types/algorithm";
import type { Trade } from "@/types/trade";

const BACKTEST_SYSTEM_PROMPT = `You are a quantitative trading analyst. Evaluate the given algorithm rules against the user's trade history and provide a structured assessment.

Output format:
**Performance Estimate** — Estimated win rate, risk/reward ratio based on the strategy logic.
**Strengths** — What this algorithm does well (2-3 bullet points).
**Weaknesses** — Risks or blind spots (2-3 bullet points).
**Compatibility** — How well this algorithm matches the user's actual trading patterns.
**Recommendation** — One clear actionable suggestion to improve the algorithm.

Be specific, reference actual numbers from the trade data when relevant. Keep the total response under 300 words.`;

function formatRules(algo: Algorithm): string {
  const r = algo.rules;
  const lines = [
    `Algorithm: ${algo.name}`,
    `Asset class: ${algo.asset_class}, Risk: ${algo.risk_level}, Capital: $${algo.capital}`,
    `Entry conditions: ${JSON.stringify(r.entry_conditions)}`,
    `Exit conditions: ${JSON.stringify(r.exit_conditions)}`,
    `Stop loss: ${r.stop_loss?.type} ${r.stop_loss?.value}%`,
    `Take profit: ${r.take_profit?.type} ${r.take_profit?.value}%`,
    `Position sizing: ${r.position_sizing?.type} ${r.position_sizing?.value}`,
    `Max positions: ${r.max_positions}`,
  ];
  return lines.join("\n");
}

function formatTradesSummary(trades: Trade[]): string {
  if (trades.length === 0) return "No trade history available.";

  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realized_pnl != null && t.realized_pnl > 0);
  const totalPnl = closed.reduce((s, t) => s + (t.realized_pnl ?? 0), 0);

  return [
    `Trade history: ${trades.length} total, ${closed.length} closed`,
    `Win rate: ${closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : 0}%`,
    `Total P&L: $${totalPnl.toFixed(2)}`,
    `Asset classes traded: ${[...new Set(trades.map((t) => t.asset_class))].join(", ")}`,
  ].join("\n");
}

export function buildAiBacktestPrompt(
  algorithm: Algorithm,
  trades: Trade[]
): { system: string; userMessage: string } {
  return {
    system: BACKTEST_SYSTEM_PROMPT,
    userMessage: `${formatRules(algorithm)}\n\n${formatTradesSummary(trades)}`,
  };
}
