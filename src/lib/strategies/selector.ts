/**
 * Picks the best strategy template for a user's preferences. Uses the AI for
 * the *selection* (one template id from a small list) — much more reliable
 * than asking it to author rules from scratch.
 */
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import type { AlgorithmFormValues } from "@/lib/validators/algorithm";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  compatibleTemplates,
  getTemplateById,
  STRATEGY_TEMPLATES,
  type RiskLevel,
  type StrategyTemplate,
} from "./templates";

const SELECTOR_SYSTEM_PROMPT = `You are a trading strategy selector. Given a user's preferences and a list of vetted strategy templates, pick the one template that best matches.

Output ONLY valid JSON of the form:
{ "template_id": "<id>", "reasoning": "<one sentence>" }

Rules:
- Pick from the provided template ids ONLY. Do not invent ids.
- Match the template's risk_levels to the user's risk_level when possible.
- If the user mentions specific patterns ("trend", "scalping", "mean reversion", "swing", "breakout", "prop firm") in their hints, pick the matching template.
- Forex/commodity users with prop-firm constraints typically want triple_confirmation or trend_pullback.
- Long-term/swing horizons typically want conservative_trend or macd_trend.
- Range-bound preference → bollinger_reversion. Trending preference → trend_pullback or breakout.`;

interface SelectorResponse {
  template_id?: string;
  reasoning?: string;
}

function buildSelectorMessage(
  values: AlgorithmFormValues,
  candidates: StrategyTemplate[]
): string {
  const lines = [
    `Asset class: ${values.asset_class}`,
    `Risk level: ${values.risk_level}`,
    `Time horizon: ${values.time_horizon}`,
    `Capital: $${values.capital.toLocaleString()}`,
  ];
  if (values.user_hints) lines.push(`User hints: ${values.user_hints}`);
  if (values.prop_firm) {
    lines.push(
      `Prop firm constraints: daily ${values.prop_firm.daily_loss_limit}%, drawdown ${values.prop_firm.max_drawdown}%, target ${values.prop_firm.profit_target}%`
    );
  }
  lines.push("\nAvailable templates:");
  for (const t of candidates) {
    lines.push(
      `- ${t.id}: ${t.name} — ${t.summary} [risk: ${t.risk_levels.join("/")}, tags: ${t.tags.join(",")}]`
    );
  }
  return lines.join("\n");
}

/**
 * Default fallback when AI selection fails or returns an invalid id.
 * Picks the first compatible template that matches the user's risk level.
 */
function defaultPick(
  candidates: StrategyTemplate[],
  riskLevel: RiskLevel
): StrategyTemplate | null {
  const exact = candidates.find((t) => t.risk_levels.includes(riskLevel));
  return exact ?? candidates[0] ?? null;
}

export async function selectStrategyTemplate(
  values: AlgorithmFormValues
): Promise<{ template: StrategyTemplate; reasoning: string }> {
  const candidates = compatibleTemplates(values.asset_class, values.time_horizon);
  const pool = candidates.length > 0 ? candidates : STRATEGY_TEMPLATES;
  const fallback = defaultPick(pool, values.risk_level as RiskLevel);
  if (!fallback) {
    throw new Error("No strategy templates compatible with the selected preferences.");
  }

  try {
    const client = getAIClient();
    const res = await client.chat.completions.create({
      model: AI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 256,
      messages: [
        { role: "system", content: SELECTOR_SYSTEM_PROMPT },
        { role: "user", content: buildSelectorMessage(values, pool) },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as SelectorResponse;
    const picked = parsed.template_id ? getTemplateById(parsed.template_id) : null;
    if (picked && pool.includes(picked)) {
      return { template: picked, reasoning: parsed.reasoning ?? "" };
    }
  } catch {
    // Fall through to default pick.
  }
  return { template: fallback, reasoning: "Selected as default for the user's risk level." };
}

/**
 * Build the final rules object from a chosen template + user inputs.
 */
export function buildRulesFromTemplate(
  template: StrategyTemplate,
  values: AlgorithmFormValues
): AlgorithmRules {
  return template.build({
    asset_class: values.asset_class,
    risk_level: values.risk_level as RiskLevel,
    capital: values.capital,
    time_horizon: values.time_horizon,
  });
}
