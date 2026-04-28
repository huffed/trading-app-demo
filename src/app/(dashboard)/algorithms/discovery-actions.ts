"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildDiscoveryPrompt } from "@/lib/ai/prompts/discovery";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { Algorithm } from "@/types/algorithm";
import type { DiscoverySuggestion } from "@/types/watchlist";

function validateSuggestion(s: unknown): s is DiscoverySuggestion {
  if (!s || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.ticker === "string" &&
    obj.ticker.length > 0 &&
    typeof obj.name === "string" &&
    typeof obj.sector === "string" &&
    typeof obj.reasoning === "string"
  );
}

export async function discoverTickers(
  algorithmId: string
): Promise<ActionResult<DiscoverySuggestion[]>> {
  const { supabase, user } = await getAuthedUser();

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();

  if (algoErr || !algo) {
    return { success: false, error: "Algorithm not found" };
  }

  const { data: watchlist } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algorithmId);

  const existingTickers = (watchlist ?? []).map((w) => w.ticker as string);

  try {
    const { system, userMessage } = buildDiscoveryPrompt(algo as Algorithm, existingTickers);

    const client = getAIClient();
    const res = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1024,
    });

    const text = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { suggestions?: unknown[] };
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const suggestions = raw.filter(validateSuggestion).map((s) => ({
      ticker: s.ticker.toUpperCase().trim(),
      name: s.name.trim(),
      sector: s.sector.trim(),
      reasoning: s.reasoning.trim(),
    }));

    return { success: true, data: suggestions };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[discovery] failed:", err);
    // Surface the actual reason — rate limit, network, parse error, etc.
    // Generic "AI unavailable" hides everything and confuses debugging.
    let friendly = detail;
    if (/429|rate.?limit|quota/i.test(detail)) {
      friendly = "Hit the AI rate limit. Wait ~1 minute and try again — Groq's free tier resets quickly.";
    } else if (/401|unauthor/i.test(detail)) {
      friendly = "GROQ_API_KEY missing or invalid — check .env.local.";
    } else if (/timeout|ECONNREFUSED|ENOTFOUND|fetch/i.test(detail)) {
      friendly = "Network error reaching the AI. Check your connection and retry.";
    } else if (/JSON|parse/i.test(detail)) {
      friendly = "AI returned malformed JSON. Try again — usually transient.";
    }
    return { success: false, error: `Discovery failed: ${friendly}` };
  }
}
