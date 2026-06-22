/**
 * CB.T1 Tier 3 — llm-trader-providers.ts (2026-06-23).
 *
 * extractJson 3-tier recovery + decision-schema validation. Tests focus
 * on extractJson (the regex-fragile bit); the HTTP wrappers themselves
 * are mocked at higher layers (entry-llm-trader.test.ts covers dispatch).
 */
import { describe, expect, it } from "vitest";
import { extractJson } from "./llm-trader-providers";

describe("extractJson — 3-tier JSON recovery", () => {
  it("Tier 1: clean JSON parses directly", () => {
    expect(extractJson('{"decision":"hold","confidence":70}')).toEqual({
      decision: "hold",
      confidence: 70,
    });
  });

  it("Tier 1: JSON with surrounding whitespace trims + parses", () => {
    expect(extractJson('   \n  {"a":1}  \n  ')).toEqual({ a: 1 });
  });

  it("Tier 2: ```json fence wraps JSON → inner extracted", () => {
    const text = '```json\n{"decision":"enter_long","confidence":80}\n```';
    expect(extractJson(text)).toEqual({ decision: "enter_long", confidence: 80 });
  });

  it("Tier 2: ``` (no language tag) fence also matches", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("Tier 2: truncated fence (no closing ```) still parses inner", () => {
    // Anthropic Haiku max_tokens cutoff mid-JSON → no closing fence
    expect(extractJson('```json\n{"decision":"hold"}')).toEqual({ decision: "hold" });
  });

  it("Tier 3: greedy {...} match for narrative-wrapped responses", () => {
    const text = 'Here is my analysis: {"decision":"exit","confidence":75} — done.';
    expect(extractJson(text)).toEqual({ decision: "exit", confidence: 75 });
  });

  it("returns null when no JSON object recoverable", () => {
    expect(extractJson("just plain text with no braces")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null on malformed JSON that survives no recovery tier", () => {
    expect(extractJson('{"decision": broken')).toBeNull();
  });

  it("greedy match finds the largest {...} span (handles nested objects)", () => {
    // The regex /{[\s\S]*}/ greedily matches from first { to last }
    expect(
      extractJson('prefix {"a":{"nested":1},"b":2} suffix')
    ).toEqual({ a: { nested: 1 }, b: 2 });
  });
});
