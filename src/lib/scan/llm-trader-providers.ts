/**
 * Provider call layer for the LLM trader — extractJson (3-tier JSON
 * recovery) + callAnthropic + callGroq. Extracted from `llm-trader.ts`
 * on 2026-06-22 (CB.H1 pass 15). Lives separately from the orchestrator
 * so the HTTP wrappers + their max_tokens calibration history aren't
 * crowded by the context-builder logic.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAIClient } from "@/lib/ai/client";
import type { LlmTraderDecision } from "./llm-trader";

const decisionSchema = z.object({
  decision: z.enum(["enter_long", "enter_short", "hold", "exit", "move_be"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(2000),
});

/** 3-tier JSON extraction. Anthropic Haiku frequently wraps responses in
 *  ```json fences even when prompted not to; the truncated-fence variant
 *  handles max_tokens cutoffs mid-JSON. Falls through to greedy {...}
 *  match for narrative-wrapped responses. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      /* fall through to greedy match */
    }
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

/** Call Anthropic Haiku (or override). Returns null on parse failure or
 *  API error. Caller decides whether to retry. max_tokens 1000 calibrated
 *  to <1% parse-fail rate on v2 prompt (raised from 200 → 600 → 1000
 *  during 2026-05-05/2026-05-08 multi-algo analog-backtest debugging). */
export async function callAnthropic(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  context: string
): Promise<LlmTraderDecision | null> {
  const res = await client.messages.create({
    model,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: context }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function callGroq(
  client: ReturnType<typeof getAIClient>,
  model: string,
  systemPrompt: string,
  context: string
): Promise<LlmTraderDecision | null> {
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
    response_format: { type: "json_object" },
    max_tokens: 1000,
    temperature: 0.2,
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
