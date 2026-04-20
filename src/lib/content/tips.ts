export interface TipDefinition {
  id: string;
  title: string;
  body: string;
  personalizedTemplate?: string;
}

export const tips: Record<string, TipDefinition> = {
  "total-pnl": {
    id: "total-pnl",
    title: "Total P&L",
    body: "Your total profit and loss across all closed trades, after commissions and fees. Green means you're up overall, red means you're down.",
    personalizedTemplate: "Your total P&L is {value}.",
  },
  "win-rate": {
    id: "win-rate",
    title: "Win Rate",
    body: "The percentage of your closed trades that were profitable. A win rate above 50% is solid, but even lower rates can be profitable with good risk management.",
    personalizedTemplate: "Your win rate is {value}.",
  },
  "open-positions": {
    id: "open-positions",
    title: "Open Positions",
    body: "Trades you've entered but haven't closed yet. Keep an eye on these — they represent your current market exposure.",
    personalizedTemplate: "You currently have {value} open position(s).",
  },
  "total-trades": {
    id: "total-trades",
    title: "Total Trades",
    body: "The total number of trades you've recorded, both open and closed. More data means better pattern recognition over time.",
    personalizedTemplate: "You've recorded {value} trade(s) so far.",
  },
  "asset-allocation": {
    id: "asset-allocation",
    title: "Asset Allocation",
    body: "How your trades are spread across different asset classes (stocks, options, crypto, etc.). Diversification can help manage risk.",
  },
  "emotion-trends": {
    id: "emotion-trends",
    title: "Emotion Trends",
    body: "A breakdown of the emotions you've logged in your journal. Tracking how you feel helps spot patterns — like impulsive trades after losses.",
  },
};

export function getTip(id: string): TipDefinition | undefined {
  return tips[id];
}

export function personalizeTip(tip: TipDefinition, value: string): string {
  if (!tip.personalizedTemplate) return tip.body;
  return `${tip.body}\n\n${tip.personalizedTemplate.replace("{value}", value)}`;
}
