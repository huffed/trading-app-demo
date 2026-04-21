"use server";

import { Type } from "@google/genai";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildRulesPrompt, buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import { buildAiBacktestPrompt } from "@/lib/ai/prompts/backtest";
import { createClient } from "@/lib/supabase/server";
import {
  algorithmFormSchema,
  algorithmRulesSchema,
  type AlgorithmFormValues,
} from "@/lib/validators/algorithm";
import type { Algorithm, AlgorithmRules, AlgorithmStatus } from "@/types/algorithm";
import type { Trade } from "@/types/trade";

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

async function generateRules(
  params: AlgorithmFormValues,
  tradeCount: number
): Promise<AlgorithmRules> {
  const client = getAIClient();
  const { system, userMessage } = buildRulesPrompt(params, tradeCount);

  const res = await client.models.generateContent({
    model: AI_MODEL,
    contents: userMessage,
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          entry_conditions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                indicator: { type: Type.STRING },
                operator: { type: Type.STRING },
                value: { type: Type.NUMBER },
                timeframe: { type: Type.STRING },
              },
              required: ["indicator", "operator", "value", "timeframe"],
            },
          },
          exit_conditions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                indicator: { type: Type.STRING },
                operator: { type: Type.STRING },
                value: { type: Type.NUMBER },
                timeframe: { type: Type.STRING },
              },
              required: ["indicator", "operator", "value", "timeframe"],
            },
          },
          stop_loss: {
            type: Type.OBJECT,
            properties: { type: { type: Type.STRING }, value: { type: Type.NUMBER } },
            required: ["type", "value"],
          },
          take_profit: {
            type: Type.OBJECT,
            properties: { type: { type: Type.STRING }, value: { type: Type.NUMBER } },
            required: ["type", "value"],
          },
          position_sizing: {
            type: Type.OBJECT,
            properties: { type: { type: Type.STRING }, value: { type: Type.NUMBER } },
            required: ["type", "value"],
          },
          max_positions: { type: Type.INTEGER },
          timeframe: { type: Type.STRING },
          asset_class: { type: Type.STRING },
        },
        required: [
          "entry_conditions", "exit_conditions", "stop_loss",
          "take_profit", "position_sizing", "max_positions",
          "timeframe", "asset_class",
        ],
      },
    },
  });

  const parsed = JSON.parse(res.text ?? "{}");
  const validated = algorithmRulesSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("AI generated invalid rules structure");
  }
  return validated.data as AlgorithmRules;
}

async function generateDescription(
  params: AlgorithmFormValues,
  tradeCount: number
): Promise<{ name: string; description: string }> {
  const client = getAIClient();
  const { system, userMessage } = buildStrategyPrompt(params, tradeCount);

  const res = await client.models.generateContent({
    model: AI_MODEL,
    contents: userMessage,
    config: { systemInstruction: system, maxOutputTokens: 1024 },
  });

  const text = res.text ?? "";
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

    const res = await client.models.generateContent({
      model: AI_MODEL,
      contents: userMessage,
      config: { systemInstruction: system, maxOutputTokens: 1024 },
    });

    const analysisText = res.text;
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
