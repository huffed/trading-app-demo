"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildRulesPrompt, buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import {
  applyManualLayers,
  clampRules,
  withPropFirmContext,
} from "@/lib/algorithm/rules-post-process";
import { createClient } from "@/lib/supabase/server";
import {
  algorithmFormSchema,
  algorithmRulesSchema,
  type AlgorithmFormValues,
} from "@/lib/validators/algorithm";
import type { Algorithm, AlgorithmRules, AlgorithmStatus } from "@/types/algorithm";
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
