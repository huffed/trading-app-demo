/**
 * Pure helpers that shape AI-generated rules before they hit the database.
 * Lives outside the server-action file so the action stays thin and these
 * helpers are easy to unit-test.
 */
import type { AlgorithmFormValues } from "@/lib/validators/algorithm";
import {
  isTechnicalCondition,
  type AlgorithmRules,
} from "@/types/algorithm";

const LONG_HORIZONS = new Set(["swing", "long term", "long_term", "weekly", "monthly"]);

/**
 * Post-process LLM-generated rules to fix common AI output problems:
 *
 * 1. **Condition count clamping:** The LLM often generates 3-4 technical entry conditions
 *    that must ALL fire simultaneously (AND logic). With daily bars, this almost never
 *    triggers — resulting in zero trades. We limit to 1 technical + 1 sentiment for long
 *    strategies, 2 total for short, 3 for forex/commodity (paired with n-of-m logic).
 *
 * 2. **RSI relaxation:** For long-term strategies, the LLM tends to output RSI < 30
 *    (textbook oversold), which rarely triggers on quality stocks. We relax to < 45.
 *
 * 3. **Decimal percentage fix:** The LLM sometimes outputs 0.05 meaning 5% instead of
 *    5 meaning 5%. Values < 1 are assumed to be decimal form and converted. Skipped
 *    for forex/commodity where sub-1% stops are correct.
 *
 * 4. **Pyramiding + news veto + n-of-m + R:R defaults:** Forex/commodity strategies
 *    pick up sensible defaults (3 max-per-ticker, 15/30 news veto, 2-of-3 entry logic,
 *    3:1 reward:risk minimum) — these were all observed wins from earlier iterations.
 */
export function clampRules(rules: AlgorithmRules, timeHorizon: string): AlgorithmRules {
  const isLong =
    LONG_HORIZONS.has(timeHorizon.toLowerCase()) || timeHorizon.toLowerCase().includes("long");
  const clamped = structuredClone(rules);
  const isFxOrCommodity =
    clamped.asset_class === "forex" || clamped.asset_class === "commodity";

  if (isLong) {
    const tech = clamped.entry_conditions.filter(isTechnicalCondition);
    const sentiment = clamped.entry_conditions.filter((c) => !isTechnicalCondition(c));
    clamped.entry_conditions = [...tech.slice(0, 1), ...sentiment.slice(0, 1)];
  } else if (isFxOrCommodity) {
    if (clamped.entry_conditions.length > 3) {
      clamped.entry_conditions = clamped.entry_conditions.slice(0, 3);
    }
  } else if (clamped.entry_conditions.length > 2) {
    clamped.entry_conditions = clamped.entry_conditions.slice(0, 2);
  }
  if (clamped.exit_conditions.length > 2) {
    clamped.exit_conditions = clamped.exit_conditions.slice(0, 2);
  }
  if (isLong) {
    for (const c of clamped.entry_conditions) {
      if (
        isTechnicalCondition(c) &&
        c.indicator.toLowerCase() === "rsi" &&
        c.operator === "less_than" &&
        c.value < 40
      ) {
        c.value = 45;
      }
    }
  }
  if (!isFxOrCommodity) {
    if (clamped.stop_loss && clamped.stop_loss.value < 1) {
      clamped.stop_loss.value = Math.round(clamped.stop_loss.value * 100);
    }
    if (clamped.take_profit && clamped.take_profit.value < 1) {
      clamped.take_profit.value = Math.round(clamped.take_profit.value * 100);
    }
  }
  if (clamped.position_sizing && clamped.position_sizing.value < 1) {
    clamped.position_sizing.value = Math.round(clamped.position_sizing.value * 100);
  }

  if (clamped.max_per_ticker == null || clamped.max_per_ticker < 1) {
    clamped.max_per_ticker = isFxOrCommodity ? 3 : 1;
  }
  // Allow up to 8 stacked positions on forex/commodity for aggressive
  // pyramiding strategies; equity stays at 3.
  const cap = isFxOrCommodity ? 8 : 3;
  if (clamped.max_per_ticker > cap) {
    clamped.max_per_ticker = cap;
  }

  if (clamped.news_veto == null && isFxOrCommodity) {
    clamped.news_veto = {
      enabled: true,
      block_minutes_before: 15,
      block_minutes_after: 30,
      min_impact: "high",
    };
  }

  if (clamped.entry_logic == null && isFxOrCommodity && clamped.entry_conditions.length >= 3) {
    clamped.entry_logic = { type: "n_of_m", n: 2 };
  }

  // 3:1 R:R minimum for forex/commodity. Indicator-driven FX strategies sit at
  // 25-35% win rate; below 3:1 they have negative expectancy.
  if (
    isFxOrCommodity &&
    clamped.stop_loss?.type === "percentage" &&
    clamped.take_profit?.type === "percentage" &&
    clamped.stop_loss.value > 0
  ) {
    const minTp = clamped.stop_loss.value * 3;
    if (clamped.take_profit.value < minTp) {
      clamped.take_profit.value = Number(minTp.toFixed(2));
    }
  }

  return clamped;
}

/**
 * Apply user-supplied prop firm config and numeric overrides on top of the
 * AI's generated rules. Manual settings always win — the AI gives a
 * sensible baseline; the form lets a power user lock in exact values.
 */
export function applyManualLayers(
  rules: AlgorithmRules,
  params: AlgorithmFormValues
): AlgorithmRules {
  const out = structuredClone(rules);

  if (params.prop_firm) {
    out.prop_firm = params.prop_firm;
  }

  if (params.news_veto) {
    out.news_veto = params.news_veto;
  }

  const o = params.overrides;
  if (o) {
    if (o.stop_loss != null) out.stop_loss = { type: "percentage", value: o.stop_loss };
    if (o.take_profit != null) out.take_profit = { type: "percentage", value: o.take_profit };
    if (o.position_size != null) {
      out.position_sizing = { type: "percentage_of_capital", value: o.position_size };
    }
    if (o.max_positions != null) out.max_positions = o.max_positions;
    if (o.max_per_ticker != null) out.max_per_ticker = o.max_per_ticker;
  }

  return out;
}

/**
 * Append a prop-firm context line to user_hints so the strategy text the AI
 * writes matches the constraints the user picked.
 */
export function withPropFirmContext(values: AlgorithmFormValues): AlgorithmFormValues {
  if (!values.prop_firm) return values;
  const pf = values.prop_firm;
  const context = `Funded/prop-firm constraints: daily loss ${pf.daily_loss_limit}%, max drawdown ${pf.max_drawdown}%, profit target ${pf.profit_target}%. Optimise for steady high-frequency trades within those limits.`;
  return {
    ...values,
    user_hints: values.user_hints ? `${values.user_hints}\n\n${context}` : context,
  };
}
