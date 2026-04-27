"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildRulesPrompt, buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import { createClient } from "@/lib/supabase/server";
import {
  algorithmFormSchema,
  algorithmRulesSchema,
  type AlgorithmFormValues,
} from "@/lib/validators/algorithm";
import {
  isTechnicalCondition,
  type Algorithm,
  type AlgorithmRules,
  type AlgorithmStatus,
} from "@/types/algorithm";
type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

export async function getAuthedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return { supabase, user };
}

const LONG_HORIZONS = new Set(["swing", "long term", "long_term", "weekly", "monthly"]);

/**
 * Post-process LLM-generated rules to fix common AI output problems:
 *
 * 1. **Condition count clamping:** The LLM often generates 3-4 technical entry conditions
 *    that must ALL fire simultaneously (AND logic). With daily bars, this almost never
 *    triggers — resulting in zero trades. We limit to 1 technical + 1 sentiment for long
 *    strategies, 2 total for short. This is a pragmatic trade-off: fewer conditions =
 *    more trades = more useful backtests.
 *
 * 2. **RSI relaxation:** For long-term strategies, the LLM tends to output RSI < 30
 *    (textbook oversold), which rarely triggers on quality stocks. We relax to < 45.
 *
 * 3. **Decimal percentage fix:** The LLM sometimes outputs 0.05 meaning 5% instead of
 *    5 meaning 5%. Values < 1 are assumed to be decimal form and converted.
 */
function clampRules(rules: AlgorithmRules, timeHorizon: string): AlgorithmRules {
  const isLong =
    LONG_HORIZONS.has(timeHorizon.toLowerCase()) || timeHorizon.toLowerCase().includes("long");
  const clamped = structuredClone(rules);
  const isFxOrCommodity =
    clamped.asset_class === "forex" || clamped.asset_class === "commodity";

  if (isLong) {
    const tech = clamped.entry_conditions.filter(isTechnicalCondition);
    const sentiment = clamped.entry_conditions.filter((c) => !isTechnicalCondition(c));
    clamped.entry_conditions = [...tech.slice(0, 1), ...sentiment.slice(0, 1)];
  } else if (clamped.entry_conditions.length > 2) {
    clamped.entry_conditions = clamped.entry_conditions.slice(0, 2);
  }
  if (clamped.exit_conditions.length > 2) {
    clamped.exit_conditions = clamped.exit_conditions.slice(0, 2);
  }
  // Relax overly strict RSI thresholds for long-term strategies
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
  // Fix decimal-form percentages (AI sometimes outputs 0.05 meaning 5%, not 5 meaning 5%).
  // Forex/commodity legitimately use sub-1% stops (e.g. 0.5 = 50 pips on EUR/USD), so we
  // skip the rescue heuristic for those asset classes — the AI prompt is explicit about
  // their tighter scale.
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

  // Default pyramiding cap. Forex/commodity benefit from stacking 2-3 entries on
  // trending pairs; equities default to single entry per ticker.
  if (clamped.max_per_ticker == null || clamped.max_per_ticker < 1) {
    clamped.max_per_ticker = isFxOrCommodity ? 3 : 1;
  }
  // Sanity cap — pyramiding > 5 on a single symbol is rarely intentional.
  if (clamped.max_per_ticker > 5) {
    clamped.max_per_ticker = 5;
  }

  return clamped;
}

async function generateRules(
  params: AlgorithmFormValues,
  tradeCount: number
): Promise<AlgorithmRules> {
  const client = getAIClient();
  const { system, userMessage } = buildRulesPrompt(params, tradeCount);

  const res = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    max_tokens: 2048,
  });

  const text = res.choices[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI returned invalid JSON for rules");
  }
  const validated = algorithmRulesSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("AI generated invalid rules structure");
  }
  return clampRules(validated.data as AlgorithmRules, params.time_horizon);
}

async function generateDescription(
  params: AlgorithmFormValues,
  tradeCount: number
): Promise<{ name: string; description: string }> {
  const client = getAIClient();
  const { system, userMessage } = buildStrategyPrompt(params, tradeCount);

  const res = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    max_tokens: 1024,
  });

  const text = res.choices[0]?.message?.content ?? "";
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const name =
    firstLine
      .replace(/^[#*\s]+/, "")
      .replace(/[*#]+$/, "")
      .trim() || "Untitled Strategy";
  return { name, description: text };
}

/**
 * Apply user-supplied prop firm config and numeric overrides on top of the
 * AI's generated rules. Manual settings always win — the AI gives us a
 * sensible baseline; the form lets a power user lock in exact values.
 */
function applyManualLayers(rules: AlgorithmRules, params: AlgorithmFormValues): AlgorithmRules {
  const out = structuredClone(rules);

  if (params.prop_firm) {
    out.prop_firm = params.prop_firm;
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
 * writes matches the constraints the user picked. The exact numbers are still
 * enforced by applyManualLayers — this just helps the prose.
 */
function withPropFirmContext(values: AlgorithmFormValues): AlgorithmFormValues {
  if (!values.prop_firm) return values;
  const pf = values.prop_firm;
  const context = `Funded/prop-firm constraints: daily loss ${pf.daily_loss_limit}%, max drawdown ${pf.max_drawdown}%, profit target ${pf.profit_target}%. Optimise for steady high-frequency trades within those limits.`;
  return {
    ...values,
    user_hints: values.user_hints ? `${values.user_hints}\n\n${context}` : context,
  };
}

export async function generateAlgorithm(
  values: AlgorithmFormValues
): Promise<ActionResult<Algorithm>> {
  const parsed = algorithmFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { count } = await supabase.from("trades").select("*", { count: "exact", head: true });

  const promptParams = withPropFirmContext(parsed.data);

  try {
    const [rules, { name, description }] = await Promise.all([
      generateRules(promptParams, count ?? 0),
      generateDescription(promptParams, count ?? 0),
    ]);

    const finalRules = applyManualLayers(rules, parsed.data);
    const finalName = parsed.data.name?.trim() || name;

    const { data, error } = await supabase
      .from("algorithms")
      .insert({
        user_id: user.id,
        name: finalName,
        description,
        asset_class: parsed.data.asset_class,
        risk_level: parsed.data.risk_level,
        time_horizon: parsed.data.time_horizon,
        capital: parsed.data.capital,
        user_hints: parsed.data.user_hints || null,
        rules: finalRules,
        status: "draft",
      })
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Algorithm generation failed";
    return { success: false, error: msg };
  }
}

export async function updateAlgorithm(
  id: string,
  updates: { name?: string; description?: string; status?: AlgorithmStatus; rules?: AlgorithmRules }
): Promise<ActionResult<Algorithm>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const { data, error } = await supabase
    .from("algorithms")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, data };
}

export async function deleteAlgorithm(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase.from("algorithms").delete().eq("id", id).eq("user_id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

export async function updateAlgorithmStatus(
  id: string,
  status: AlgorithmStatus
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data, error } = await supabase
    .from("algorithms")
    .update({ status })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

export async function runLiveSignal(algorithmId: string, ticker: string): Promise<ActionResult> {
  const { evaluateLiveSignal } = await import("@/lib/signals/evaluate-live");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) {
    return { success: false, error: "Algorithm not found" };
  }

  try {
    const result = await evaluateLiveSignal(
      algo.rules as AlgorithmRules,
      ticker,
      (algo.description as string) ?? ""
    );
    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signal evaluation failed";
    return { success: false, error: msg };
  }
}
