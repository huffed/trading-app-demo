"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildRulesPrompt, buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import { buildAiBacktestPrompt } from "@/lib/ai/prompts/backtest";
import { createClient } from "@/lib/supabase/server";
import {
  algorithmFormSchema,
  algorithmRulesSchema,
  type AlgorithmFormValues,
} from "@/lib/validators/algorithm";
import { isTechnicalCondition, type Algorithm, type AlgorithmRules, type AlgorithmStatus } from "@/types/algorithm";
import type { Trade } from "@/types/trade";

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

const LONG_HORIZONS = new Set(["swing", "long term", "long_term", "weekly", "monthly"]);

function clampRules(rules: AlgorithmRules, timeHorizon: string): AlgorithmRules {
  const isLong = LONG_HORIZONS.has(timeHorizon.toLowerCase()) || timeHorizon.toLowerCase().includes("long");
  const clamped = { ...rules };
  // Limit technical entry conditions to 1 for swing/long (multiple technicals that all must fire = zero trades)
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
      if (isTechnicalCondition(c) && c.indicator.toLowerCase() === "rsi" && c.operator === "less_than" && c.value < 40) {
        c.value = 45;
      }
    }
  }
  // Fix decimal-form percentages (AI sometimes outputs 0.05 meaning 5%, not 5 meaning 5%)
  if (clamped.stop_loss && clamped.stop_loss.value < 1) { clamped.stop_loss.value = Math.round(clamped.stop_loss.value * 100); }
  if (clamped.take_profit && clamped.take_profit.value < 1) { clamped.take_profit.value = Math.round(clamped.take_profit.value * 100); }
  if (clamped.position_sizing && clamped.position_sizing.value < 1) { clamped.position_sizing.value = Math.round(clamped.position_sizing.value * 100); }
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
  const parsed = JSON.parse(text);
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
  const name = firstLine.replace(/^[#*\s]+/, "").replace(/[*#]+$/, "").trim() || "Untitled Strategy";
  return { name, description: text };
}

export async function generateAlgorithm(
  values: AlgorithmFormValues
): Promise<ActionResult> {
  const parsed = algorithmFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { count } = await supabase
    .from("trades")
    .select("*", { count: "exact", head: true });

  try {
    const [rules, { name, description }] = await Promise.all([
      generateRules(parsed.data, count ?? 0),
      generateDescription(parsed.data, count ?? 0),
    ]);

    const { data, error } = await supabase
      .from("algorithms")
      .insert({
        user_id: user.id,
        name,
        description,
        asset_class: parsed.data.asset_class,
        risk_level: parsed.data.risk_level,
        time_horizon: parsed.data.time_horizon,
        capital: parsed.data.capital,
        user_hints: parsed.data.user_hints || null,
        rules,
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

export async function deleteAlgorithm(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase
    .from("algorithms")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

export async function updateAlgorithmStatus(
  id: string,
  status: AlgorithmStatus
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

export async function runAiBacktest(algorithmId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const { data: trades } = await supabase.from("trades").select("*");

  try {
    const client = getAIClient();
    const { system, userMessage } = buildAiBacktestPrompt(
      algo as Algorithm,
      (trades ?? []) as Trade[]
    );

    const res = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
    });

    const analysisText = res.choices[0]?.message?.content;
    if (!analysisText) return { success: false, error: "No response from AI" };

    await supabase
      .from("algorithms")
      .update({ ai_analysis: analysisText })
      .eq("id", algorithmId);

    return { success: true, data: { ai_analysis: analysisText } };
  } catch {
    return { success: false, error: "AI is temporarily unavailable. Please try again in a moment." };
  }
}

export async function runHistoricalBacktest(
  algorithmId: string,
  symbol: string,
  outputSize: "compact" | "full"
): Promise<ActionResult> {
  const { fetchDailyPrices } = await import("@/lib/market-data/alpha-vantage");
  const { runBacktest } = await import("@/lib/market-data/backtest-engine");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) return { success: false, error: "Algorithm not found" };

  const rules = algo.rules as AlgorithmRules;
  if (!rules.entry_conditions || rules.entry_conditions.length === 0) {
    return { success: false, error: "Algorithm has no trading rules. Try regenerating it." };
  }

  try {
    const prices = await fetchDailyPrices(symbol, outputSize);
    if (prices.length < 30) {
      return { success: false, error: "Not enough price data for backtesting" };
    }

    const results = runBacktest(rules, prices, algo.capital);

    await supabase
      .from("algorithms")
      .update({ backtest_results: results })
      .eq("id", algorithmId);

    return { success: true, data: results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Backtest failed";
    return { success: false, error: msg };
  }
}

export async function runLiveSignal(
  algorithmId: string,
  ticker: string
): Promise<ActionResult> {
  const { evaluateLiveSignal } = await import("@/lib/signals/evaluate-live");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { return { success: false, error: "Not authenticated" }; }

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) { return { success: false, error: "Algorithm not found" }; }

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
