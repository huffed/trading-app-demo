import type { AlgorithmFormValues } from "@/lib/validators/algorithm";

const STRATEGY_SYSTEM_PROMPT = `You are a quantitative trading strategist. Design a profitable, risk-managed trading strategy based on user preferences.

Provide:
1. A concise strategy name (5-10 words)
2. A clear explanation (150-250 words) covering:
   - The logic in simple terms
   - Why this suits their risk level and capital
   - Key risks and how the strategy manages them

Guidelines:
- Conservative = tight stops (2-3%), small positions (5-8% of capital), proven indicators
- Moderate = balanced stops (3-5%), medium positions (8-12%), combined indicators
- Aggressive = wider stops (5-10%), larger positions (12-20%), momentum-focused
- Favor asymmetric risk/reward (reward > risk)`;

const RULES_SYSTEM_PROMPT = `You are a trading algorithm generator. Output ONLY valid JSON matching this exact schema — no explanation, no markdown, no code blocks. Just the raw JSON object.

Schema:
{
  "entry_conditions": [{ "indicator": string, "operator": "less_than"|"greater_than"|"crosses_above"|"crosses_below", "value": number, "timeframe": "1d"|"4h"|"1h" }],
  "exit_conditions": [{ "indicator": string, "operator": "less_than"|"greater_than"|"crosses_above"|"crosses_below", "value": number, "timeframe": "1d"|"4h"|"1h" }],
  "stop_loss": { "type": "percentage"|"fixed", "value": number },
  "take_profit": { "type": "percentage"|"fixed", "value": number },
  "position_sizing": { "type": "percentage_of_capital"|"fixed_amount", "value": number },
  "max_positions": number (integer),
  "timeframe": "1d"|"4h"|"1h",
  "asset_class": "equity"|"option"|"future"|"forex"|"crypto"
}

Valid indicators: RSI, SMA, SMA20, SMA50, EMA, EMA12, EMA26, MACD, BollingerBands_upper, BollingerBands_lower

Rules:
- Use 2-3 entry conditions and 1-2 exit conditions
- Conservative: stop_loss 2-3%, take_profit 5-8%, position_sizing 5-8%
- Moderate: stop_loss 3-5%, take_profit 8-15%, position_sizing 8-12%
- Aggressive: stop_loss 5-10%, take_profit 15-25%, position_sizing 12-20%
- Always include stop_loss AND take_profit`;

const RISK_DESCRIPTIONS: Record<string, string> = {
  conservative: "Low risk, capital preservation, steady returns",
  moderate: "Balanced risk and reward, moderate position sizes",
  aggressive: "Higher risk tolerance, momentum-focused, larger positions",
};

function buildUserMessage(params: AlgorithmFormValues, tradeCount?: number): string {
  const parts = [
    `Asset class: ${params.asset_class}`,
    `Risk level: ${params.risk_level} (${RISK_DESCRIPTIONS[params.risk_level]})`,
    `Capital: $${params.capital.toLocaleString()}`,
    `Time horizon: ${params.time_horizon}`,
  ];
  if (params.user_hints) {
    parts.push(`User notes: ${params.user_hints}`);
  }
  if (tradeCount && tradeCount > 0) {
    parts.push(`User has ${tradeCount} trades on record.`);
  }
  return parts.join("\n");
}

export function buildStrategyPrompt(
  params: AlgorithmFormValues,
  tradeCount?: number
): { system: string; userMessage: string } {
  return {
    system: STRATEGY_SYSTEM_PROMPT,
    userMessage: buildUserMessage(params, tradeCount),
  };
}

export function buildRulesPrompt(
  params: AlgorithmFormValues,
  tradeCount?: number
): { system: string; userMessage: string } {
  return {
    system: RULES_SYSTEM_PROMPT,
    userMessage: buildUserMessage(params, tradeCount),
  };
}
