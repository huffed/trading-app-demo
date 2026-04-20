import type { AlgorithmFormValues } from "@/lib/validators/algorithm";

const ALGORITHM_SYSTEM_PROMPT = `You are a quantitative trading strategist built into QuantTrader. Your job is to design profitable, risk-managed trading algorithms based on user preferences.

You MUST output two sections separated by the exact marker "---RULES_JSON---":

1. **Strategy Explanation** (plain English, 150-250 words):
   - Name the strategy (concise, descriptive)
   - Explain the logic in simple terms a beginner would understand
   - Why this approach suits their risk level and capital
   - Key risks and how the algorithm manages them

2. **Rules JSON** (valid JSON matching this exact schema):
{
  "entry_conditions": [{ "indicator": "RSI|SMA|EMA|MACD|BollingerBands", "operator": "less_than|greater_than|crosses_above|crosses_below", "value": number, "timeframe": "1d|4h|1h" }],
  "exit_conditions": [{ "indicator": "...", "operator": "...", "value": number, "timeframe": "..." }],
  "stop_loss": { "type": "percentage|fixed", "value": number },
  "take_profit": { "type": "percentage|fixed", "value": number },
  "position_sizing": { "type": "percentage_of_capital|fixed_amount", "value": number },
  "max_positions": number,
  "timeframe": "1d|4h|1h",
  "asset_class": "equity|option|future|forex|crypto"
}

Guidelines:
- Conservative = tight stops (2-3%), small positions (5-8% of capital), proven indicators
- Moderate = balanced stops (3-5%), medium positions (8-12%), combined indicators
- Aggressive = wider stops (5-10%), larger positions (12-20%), momentum-focused
- Always include both stop loss AND take profit
- Favor strategies with asymmetric risk/reward (reward > risk)
- Use 2-3 entry conditions and 1-2 exit conditions (don't overcomplicate)`;

const RISK_DESCRIPTIONS: Record<string, string> = {
  conservative: "Low risk, capital preservation, steady returns",
  moderate: "Balanced risk and reward, moderate position sizes",
  aggressive: "Higher risk tolerance, momentum-focused, larger positions",
};

export function buildAlgorithmPrompt(
  params: AlgorithmFormValues,
  tradeCount?: number
): { system: string; userMessage: string } {
  const parts = [
    `Generate a trading algorithm with these preferences:`,
    `- Asset class: ${params.asset_class}`,
    `- Risk level: ${params.risk_level} (${RISK_DESCRIPTIONS[params.risk_level]})`,
    `- Capital: $${params.capital.toLocaleString()}`,
    `- Time horizon: ${params.time_horizon}`,
  ];

  if (params.user_hints) {
    parts.push(`- User notes: ${params.user_hints}`);
  }

  if (tradeCount && tradeCount > 0) {
    parts.push(`\nThe user has ${tradeCount} trades on record.`);
  }

  return {
    system: ALGORITHM_SYSTEM_PROMPT,
    userMessage: parts.join("\n"),
  };
}

export const RULES_DELIMITER = "---RULES_JSON---";
