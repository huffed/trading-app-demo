import type { AlgorithmFormValues } from "@/lib/validators/algorithm";

const STRATEGY_SYSTEM_PROMPT = `You are a quantitative trading strategist. Design a profitable, risk-managed trading strategy based on user preferences.

Start with the strategy name on the first line (no prefix, no formatting, just the name).
Then explain in 150-250 words:
- The logic in simple terms a beginner would understand
- Why this suits their risk level and capital
- Key risks and how the strategy manages them

Do NOT repeat the strategy name in the body. Do NOT use "Strategy Name:" prefixes.

Guidelines:
- Conservative = tight stops (2-3%), small positions (5-8% of capital), proven indicators
- Moderate = balanced stops (3-5%), medium positions (8-12%), combined indicators
- Aggressive = wider stops (5-10%), larger positions (12-20%), momentum-focused
- Favor asymmetric risk/reward (reward > risk)`;

const RULES_SYSTEM_PROMPT = `You are a trading algorithm generator. Output ONLY valid JSON — no explanation, no markdown.

CRITICAL: The "value" field has different meanings depending on the indicator:
- RSI: a threshold level (e.g., 30 = oversold, 70 = overbought). Range: 0-100.
- SMA/EMA: a PRICE level the indicator crosses. Use a realistic price or set value to the period length and use crosses_above/crosses_below to compare against price.
- MACD: a signal line crossing level (typically 0 for centerline crosses).
- BollingerBands_upper/lower: a price level (use 0 for "price touches band").

For moving average crossovers, use TWO conditions:
  - { "indicator": "EMA12", "operator": "crosses_above", "value": 0, "timeframe": "1d" }
    means EMA12 crosses above its signal (EMA26). Value 0 = compare against the companion MA.
  - { "indicator": "SMA20", "operator": "greater_than", "value": 0, "timeframe": "1d" }
    means price is above SMA20. Value 0 = compare price against the indicator.

GOOD examples:
  { "indicator": "RSI", "operator": "less_than", "value": 30, "timeframe": "1d" }
  { "indicator": "RSI", "operator": "greater_than", "value": 70, "timeframe": "1d" }
  { "indicator": "EMA12", "operator": "crosses_above", "value": 0, "timeframe": "1d" }
  { "indicator": "BollingerBands_lower", "operator": "less_than", "value": 0, "timeframe": "1d" }

BAD examples (NEVER do this):
  { "indicator": "SMA20", "operator": "crosses_above", "value": 50 } — 50 is not a valid SMA threshold
  { "indicator": "SMA50", "operator": "greater_than", "value": 200 } — nonsensical comparison

Schema:
{
  "entry_conditions": [{ "indicator": string, "operator": string, "value": number, "timeframe": string }],
  "exit_conditions": [{ "indicator": string, "operator": string, "value": number, "timeframe": string }],
  "stop_loss": { "type": "percentage"|"fixed", "value": number },
  "take_profit": { "type": "percentage"|"fixed", "value": number },
  "position_sizing": { "type": "percentage_of_capital"|"fixed_amount", "value": number },
  "max_positions": integer,
  "timeframe": "1d"|"4h"|"1h",
  "asset_class": string
}

Valid indicators: RSI, SMA20, SMA50, EMA12, EMA26, MACD, BollingerBands_upper, BollingerBands_lower
Valid operators: less_than, greater_than, crosses_above, crosses_below

Rules:
- Use 2-3 entry conditions and 1-2 exit conditions
- RSI conditions MUST have meaningful thresholds (20-40 for entry, 60-80 for exit)
- MA/BB conditions should use value 0 (compare against price or companion indicator)
- Conservative: stop_loss 2-3%, take_profit 5-8%, position_sizing 5-8%, max_positions 2-3
- Moderate: stop_loss 3-5%, take_profit 8-15%, position_sizing 8-12%, max_positions 3-5
- Aggressive: stop_loss 5-10%, take_profit 15-25%, position_sizing 12-20%, max_positions 5-8`;

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
