"use server";

import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildDiscoveryPrompt } from "@/lib/ai/prompts/discovery";
import { getInstrumentMeta, isCurrencyPair } from "@/lib/constants/markets";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { algorithmFromRow } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/lib/types/action-result";
import type { DiscoverySuggestion } from "@/types/watchlist";

const RECENT_PAUSE_WINDOW_DAYS = 7;

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

/**
 * Refuse suggestions that violate the catalog contract — for forex /
 * commodity algos the LLM occasionally invents symbols (TRY/USD,
 * DKK/SEK) that would later 80x-oversize because they bypass our
 * size-clamp guards. Equity is permissive because the LLM picks any
 * NYSE/NASDAQ ticker and we don't keep a curated equity universe.
 */
function isInCatalog(ticker: string, assetClass: string): boolean {
  if (assetClass === "equity" || assetClass === "crypto") return true;
  const meta = getInstrumentMeta(ticker);
  if (meta) return true;
  // Forex pair format checking — if it looks like a pair but isn't in
  // the catalog, refuse. Equivalent to riskToLots' hard guard but
  // applied at suggestion-time so the operator never sees bad pairs.
  if (assetClass === "forex" && isCurrencyPair(ticker)) return false;
  if (assetClass === "commodity") return false;
  return true;
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
    .select("ticker, auto_paused, auto_paused_at")
    .eq("algorithm_id", algorithmId);

  const watchRows = watchlist ?? [];
  const existingTickers = watchRows.map((w) => w.ticker as string);

  // Exclude tickers auto-paused by pair-quality in the last 7 days.
  // Discovery used to silently re-add pairs the live engine had just
  // pruned — operator confusion + wasted scan cycles. Auto-paused-but-
  // older pairs CAN be re-suggested (the underlying issue may have
  // resolved over weeks). Currently-active rows are excluded via the
  // ALREADY WATCHING block in the prompt.
  const recentPauseCutoff = Date.now() - RECENT_PAUSE_WINDOW_DAYS * 86_400_000;
  const recentlyPausedTickers = watchRows
    .filter((w) => w.auto_paused === true && w.auto_paused_at != null)
    .filter((w) => new Date(w.auto_paused_at as string).getTime() >= recentPauseCutoff)
    .map((w) => w.ticker as string);

  const excludedFromSuggestions = Array.from(
    new Set([...existingTickers, ...recentlyPausedTickers])
  );

  try {
    const { system, userMessage } = buildDiscoveryPrompt(
      algorithmFromRow(algo),
      excludedFromSuggestions
    );

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
    const assetClass = algo.asset_class;
    const suggestions = raw
      .filter(validateSuggestion)
      .map((s) => ({
        ticker: s.ticker.toUpperCase().trim(),
        name: s.name.trim(),
        sector: s.sector.trim(),
        reasoning: s.reasoning.trim(),
      }))
      // Defense-in-depth: prompt tells the LLM to stay in the curated
      // universe but it occasionally invents symbols. Drop anything not
      // in the catalog so the operator never sees a pair that would
      // silently fail at sizing time.
      .filter((s) => isInCatalog(s.ticker, assetClass));

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
