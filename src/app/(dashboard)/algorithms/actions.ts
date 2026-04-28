"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildRulesPrompt, buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import {
  applyManualLayers,
  clampRules,
  withPropFirmContext,
} from "@/lib/algorithm/rules-post-process";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import {
  buildRulesFromTemplate,
  selectStrategyTemplate,
} from "@/lib/strategies/selector";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";
import {
  algorithmFormSchema,
  algorithmRulesSchema,
  algorithmUpdateSchema,
  type AlgorithmFormValues,
  type AlgorithmUpdate,
} from "@/lib/validators/algorithm";
import type { Algorithm, AlgorithmRules, AlgorithmStatus } from "@/types/algorithm";

export type AlgorithmUpdateSource = "chat" | "ui" | "api";

async function generateRulesFreeForm(
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

/**
 * Pick the rule-generation path. Forex/commodity goes through the vetted
 * template library — free-form generation has consistently produced
 * un-tradeable strategies in those markets. Equity/crypto stays on the
 * AI free-form path which works well for stock trade-history strategies.
 */
async function generateRules(
  params: AlgorithmFormValues,
  tradeCount: number
): Promise<AlgorithmRules> {
  const usesTemplates =
    params.asset_class === "forex" || params.asset_class === "commodity";
  if (usesTemplates) {
    const { template } = await selectStrategyTemplate(params);
    const rules = buildRulesFromTemplate(template, params);
    return clampRules(rules, params.time_horizon);
  }
  return generateRulesFreeForm(params, tradeCount);
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
  updates: AlgorithmUpdate,
  source: AlgorithmUpdateSource = "ui"
): Promise<ActionResult<Algorithm>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  // Recursive validation. Without this an LLM-emitted [EDIT_ALGORITHM]
  // marker could write a malformed rules blob — the type signature is
  // erased at runtime and the DB column is JSONB.
  const parsed = algorithmUpdateSchema.safeParse(updates);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "payload";
    return {
      success: false,
      error: `Invalid update at ${path}: ${issue?.message ?? "unknown"}`,
    };
  }
  const validated: AlgorithmUpdate = { ...parsed.data };

  // Need the prior state to (a) compute the diff for the audit log and
  // (b) supply time_horizon to clampRules when normalizing rule updates.
  const { data: current, error: fetchErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (fetchErr || !current) {
    return { success: false, error: "Algorithm not found" };
  }

  if (validated.rules) {
    validated.rules = clampRules(
      validated.rules,
      (current.time_horizon as string) ?? ""
    );
  }

  const fieldsChanged: string[] = [];
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(validated) as Array<keyof AlgorithmUpdate>) {
    const newVal = validated[key];
    const oldVal = (current as Record<string, unknown>)[key];
    if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      fieldsChanged.push(key);
      before[key] = oldVal ?? null;
    }
  }

  const { data, error } = await supabase
    .from("algorithms")
    .update(validated)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  if (fieldsChanged.length > 0) {
    const auditInsert = await supabase.from("algorithm_rule_changes").insert({
      user_id: user.id,
      algorithm_id: id,
      source,
      fields_changed: fieldsChanged,
      before,
      after: validated,
    });
    if (auditInsert.error) {
      // Audit failure is non-fatal — the update already landed. Surface
      // it in the server log so the operator can investigate, but don't
      // roll back the user's change.
      console.error("[updateAlgorithm] audit insert failed", auditInsert.error);
    }
  }

  return { success: true, data };
}

export async function deleteAlgorithm(id: string): Promise<ActionResult<null>> {
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
): Promise<ActionResult<Algorithm>> {
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
  return { success: true, data: data as Algorithm };
}

export async function runLiveSignal(
  algorithmId: string,
  ticker: string
): Promise<ActionResult<SignalResult>> {
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
