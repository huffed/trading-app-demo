import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client used by the LLM-trader path. Server-side only —
 * never imported by client components.
 */
export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }
  return new Anthropic({ apiKey });
}

/** Default Haiku model — validated as the LLM-trader's discretionary
 *  reasoning baseline (see `feat/llm-trader-mvp` branch / commit 2bea3f3
 *  for the multi-window backtest). Cheap (~$0.07 per backtest run, ~$1/mo
 *  per live algo) and fast enough for 4h-cadence decisions. */
export const ANTHROPIC_HAIKU_MODEL = "claude-haiku-4-5-20251001";
