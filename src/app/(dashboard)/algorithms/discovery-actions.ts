"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildDiscoveryPrompt } from "@/lib/ai/prompts/discovery";
import type { Algorithm } from "@/types/algorithm";
import type { DiscoverySuggestion } from "@/types/watchlist";
import { getAuthedUser } from "./actions";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

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
  } catch {
    return {
      success: false,
      error: "Discovery failed. AI may be temporarily unavailable — try again in a moment.",
    };
  }
}
