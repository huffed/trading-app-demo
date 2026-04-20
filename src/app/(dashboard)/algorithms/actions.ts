"use server";

import { getAnthropicClient } from "@/lib/ai/client";
import { buildAlgorithmPrompt, RULES_DELIMITER } from "@/lib/ai/prompts/algorithm";
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

function parseRulesFromResponse(text: string): AlgorithmRules | null {
  const parts = text.split(RULES_DELIMITER);
  if (parts.length < 2) return null;

  const jsonStr = parts[1].trim().replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(jsonStr);
    const result = algorithmRulesSchema.safeParse(parsed);
    return result.success ? (result.data as AlgorithmRules) : null;
  } catch {
    return null;
  }
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

  const client = getAnthropicClient();
  const { system, userMessage } = buildAlgorithmPrompt(parsed.data, count ?? 0);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { success: false, error: "No response from AI" };
  }

  const fullText = textBlock.text;
  const rules = parseRulesFromResponse(fullText);
  const description = fullText.split(RULES_DELIMITER)[0].trim();
  const nameLine = description.split("\n").find((l) => l.startsWith("**") || l.startsWith("#"));
  const name = nameLine?.replace(/[#*]/g, "").trim() ?? "Untitled Strategy";

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
      rules: rules ?? {},
      status: "draft",
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data };
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

  const client = getAnthropicClient();
  const { system, userMessage } = buildAiBacktestPrompt(
    algo as Algorithm,
    (trades ?? []) as Trade[]
  );

  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    return { success: false, error: "No response from AI" };
  }

  await supabase
    .from("algorithms")
    .update({ ai_analysis: text.text })
    .eq("id", algorithmId);

  return { success: true, data: { ai_analysis: text.text } };
}
