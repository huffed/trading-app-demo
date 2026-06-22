/**
 * Unit tests for llm-trader (CB.T1 pass 20, 2026-06-22).
 * Twentieth + FINAL unit-testable file in `src/lib/scan/`.
 * Brings scan/ unit-test coverage to 20/21 = 95% (practical ceiling;
 * the remaining 4 are integration-heavy orchestrators that need E2E).
 *
 * Tests 3 exports:
 *   - isBarCloseScan (timeframe → wall-clock UTC throttle gate)
 *   - buildLlmTraderContext (pure context builder + regime derivation)
 *   - evaluateLlmTrader (provider routing + one-shot retry on transient
 *     failure; HTTP mocked via Anthropic + Groq client mocks)
 *
 * Coverage (~28 tests):
 *  isBarCloseScan throttle gate:
 *   - 4h: fires at hour ∈ {0,4,8,12,16,20} AND minute < 15
 *   - 1h: fires every hour, minute < 15
 *   - 30m: fires at minute < 15 OR minute ∈ [30, 45)
 *   - 15m: always true
 *   - 1d: fires only at hour=0, minute < 15 (UTC midnight)
 *   - Unknown TF: defaults to true (no harm done)
 *
 *  buildLlmTraderContext (pure):
 *   - Returns {userMessage, regime}
 *   - Regime HH when last3High>prev3High AND last3Low>prev3Low
 *   - Regime LH when both lower
 *   - Regime RANGING when neither pattern holds
 *   - Regime "n/a" when dailyBars.length < 21
 *   - userMessage starts with currentTimestamp prefix
 *   - userMessage ends with "Decide."
 *   - "FLAT." inserted when no position
 *   - Position context shows "LONG from X" + P&L%
 *   - R-multiple computation uses initialStopPrice when provided (BE-move
 *     anchor — entry-time SL, not mutated)
 *   - Falls back to stopPrice when initialStopPrice absent
 *   - DXY: "n/a" when eurusdBars empty/null
 *   - DXY: contains directional %change when bars present (inverted EUR/USD)
 *   - Intermarket: "n/a" when absent
 *   - Intermarket: XAU/XAG ratio + silver 7d %change when silver present
 *   - recentOutcomes line included when provided
 *   - recentOutcomes line OMITTED when null
 *   - higherTfBars line included when ≥1 TF has ≥8 bars; skipped otherwise
 *
 *  evaluateLlmTrader (HTTP mocked):
 *   - Provider='anthropic' routes to Anthropic client
 *   - Provider='groq' routes to Groq client
 *   - Returns full evaluation shape (decision, regime, userMessage,
 *     promptVersion, provider, model)
 *   - First-call failure → retry succeeds (decision returned)
 *   - Both calls fail → decision: null
 *   - Both calls throw → decision: null (caught, no propagation)
 *   - model defaults: anthropic → ANTHROPIC_HAIKU_MODEL, groq → AI_MODEL
 *
 *  extractJson (tested via evaluateLlmTrader):
 *   - Plain JSON parses
 *   - ```json fenced wrapper stripped
 *   - Greedy {...} extraction works when wrapper malformed
 *   - Returns null on completely unparseable text → decision: null
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_HAIKU_MODEL, getAnthropicClient } from "@/lib/ai/anthropic-client";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import type { PriceBar } from "@/lib/market-data/types";
import { getPrompt } from "@/lib/scan/llm-trader-prompts";
import {
  buildLlmTraderContext,
  evaluateLlmTrader,
  isBarCloseScan,
  type LlmTraderContext,
} from "./llm-trader";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: vi.fn(),
  ANTHROPIC_HAIKU_MODEL: "claude-haiku-4-5-mock",
}));
vi.mock("@/lib/ai/client", () => ({
  getAIClient: vi.fn(),
  AI_MODEL: "llama-3.3-mock",
}));
vi.mock("@/lib/scan/llm-trader-prompts", () => ({
  getPrompt: vi.fn().mockReturnValue("MOCK SYSTEM PROMPT"),
  DEFAULT_PROMPT_VERSION: "v2",
}));

const mockedGetAnthropic = vi.mocked(getAnthropicClient);
const mockedGetAI = vi.mocked(getAIClient);
const mockedGetPrompt = vi.mocked(getPrompt);

// ---- Fixture builders. ------------------------------------------------
function makeBar(date: string, opts: Partial<PriceBar> = {}): PriceBar {
  return {
    date,
    open: 3000,
    high: 3010,
    low: 2990,
    close: 3005,
    volume: 100,
    ...opts,
  };
}

/** Build N bars at hourly cadence ending at given ISO. Each bar's
 *  values can be overridden by index via the gen callback. */
function makeBars(n: number, endIso: string, gen?: (i: number) => Partial<PriceBar>): PriceBar[] {
  const out: PriceBar[] = [];
  const endMs = Date.parse(endIso);
  for (let i = 0; i < n; i++) {
    const ts = new Date(endMs - (n - 1 - i) * 3600_000).toISOString();
    out.push(makeBar(ts, gen?.(i) ?? {}));
  }
  return out;
}

/** Build a daily-bars fixture with a specific regime pattern. */
function makeDailyBars(regime: "HH" | "LH" | "RANGING", count = 21): PriceBar[] {
  const out: PriceBar[] = [];
  for (let i = 0; i < count; i++) {
    const date = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
    let high = 3000 + i * 5;
    let low = 2990 + i * 5;
    if (regime === "LH") {
      // Mirror: highs descend
      high = 3100 - i * 5;
      low = 3090 - i * 5;
    } else if (regime === "RANGING") {
      // Oscillate ±20 around 3000
      high = 3020 + ((i % 2) * 10);
      low = 2980 - ((i % 2) * 10);
    }
    out.push(makeBar(date, { high, low, open: (high + low) / 2, close: (high + low) / 2 + 1 }));
  }
  return out;
}

function makeContext(overrides: Partial<LlmTraderContext> = {}): LlmTraderContext {
  return {
    currentTimestamp: "2026-06-22T16:00:00Z",
    bars: makeBars(20, "2026-06-22T16:00:00Z"),
    dailyBars: makeDailyBars("HH"),
    timeframe: "4h",
    ...overrides,
  };
}

// ---- Anthropic + Groq client mocks. -----------------------------------
function makeAnthropicMock(opts: {
  responses?: Array<string | Error>;
} = {}): { client: { messages: { create: ReturnType<typeof vi.fn> } } } {
  const responses = opts.responses ?? [];
  const create = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) {
      create.mockRejectedValueOnce(r);
    } else {
      create.mockResolvedValueOnce({ content: [{ type: "text", text: r }] });
    }
  }
  return { client: { messages: { create } } };
}

function makeGroqMock(opts: {
  responses?: Array<string | Error>;
} = {}): { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } } {
  const responses = opts.responses ?? [];
  const create = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) {
      create.mockRejectedValueOnce(r);
    } else {
      create.mockResolvedValueOnce({ choices: [{ message: { content: r } }] });
    }
  }
  return { client: { chat: { completions: { create } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetPrompt.mockReturnValue("MOCK SYSTEM PROMPT");
});

afterEach(() => {
  vi.useRealTimers();
});

// ======================================================================
// isBarCloseScan — throttle gate
// ======================================================================

describe("isBarCloseScan — throttle gate", () => {
  function utcTime(hour: number, minute: number): Date {
    return new Date(Date.UTC(2026, 5, 22, hour, minute, 0));
  }

  it("4h: fires at hour ∈ {0,4,8,12,16,20} AND minute < 15", () => {
    for (const h of [0, 4, 8, 12, 16, 20]) {
      expect(isBarCloseScan("4h", utcTime(h, 0))).toBe(true);
      expect(isBarCloseScan("4h", utcTime(h, 14))).toBe(true);
      expect(isBarCloseScan("4h", utcTime(h, 15))).toBe(false); // boundary
    }
    for (const h of [1, 2, 3, 5, 7, 11]) {
      expect(isBarCloseScan("4h", utcTime(h, 5))).toBe(false);
    }
  });

  it("1h: fires every hour, minute < 15", () => {
    expect(isBarCloseScan("1h", utcTime(3, 5))).toBe(true);
    expect(isBarCloseScan("1h", utcTime(17, 14))).toBe(true);
    expect(isBarCloseScan("1h", utcTime(3, 15))).toBe(false);
    expect(isBarCloseScan("1h", utcTime(3, 45))).toBe(false);
  });

  it("30m: fires at minute < 15 OR minute ∈ [30, 45)", () => {
    expect(isBarCloseScan("30m", utcTime(3, 5))).toBe(true);
    expect(isBarCloseScan("30m", utcTime(3, 35))).toBe(true);
    expect(isBarCloseScan("30m", utcTime(3, 14))).toBe(true);
    expect(isBarCloseScan("30m", utcTime(3, 44))).toBe(true);
    expect(isBarCloseScan("30m", utcTime(3, 15))).toBe(false);
    expect(isBarCloseScan("30m", utcTime(3, 45))).toBe(false);
    expect(isBarCloseScan("30m", utcTime(3, 29))).toBe(false);
  });

  it("15m: always true (every quarter-hour)", () => {
    for (const m of [0, 5, 15, 16, 30, 45, 59]) {
      expect(isBarCloseScan("15m", utcTime(3, m))).toBe(true);
    }
  });

  it("1d: fires only at hour=0 AND minute < 15 (UTC midnight)", () => {
    expect(isBarCloseScan("1d", utcTime(0, 5))).toBe(true);
    expect(isBarCloseScan("1d", utcTime(0, 14))).toBe(true);
    expect(isBarCloseScan("1d", utcTime(0, 15))).toBe(false);
    expect(isBarCloseScan("1d", utcTime(1, 5))).toBe(false);
    expect(isBarCloseScan("1d", utcTime(12, 5))).toBe(false);
    // 1day alias works too
    expect(isBarCloseScan("1day", utcTime(0, 5))).toBe(true);
  });

  it("Unknown timeframe → defaults to true (let the LLM run, no harm done)", () => {
    expect(isBarCloseScan("17m", utcTime(7, 17))).toBe(true);
    expect(isBarCloseScan("totally-unknown", utcTime(13, 27))).toBe(true);
  });

  it("Timeframe is case-insensitive (lowercased before switch)", () => {
    expect(isBarCloseScan("4H", utcTime(8, 5))).toBe(true);
    expect(isBarCloseScan("1H", utcTime(8, 5))).toBe(true);
  });
});

// ======================================================================
// buildLlmTraderContext — regime derivation
// ======================================================================

describe("buildLlmTraderContext — regime derivation", () => {
  it("Regime HH when last3 high+low both ABOVE prev3 high+low", () => {
    const { regime } = buildLlmTraderContext(makeContext({ dailyBars: makeDailyBars("HH") }));
    expect(regime).toBe("HH");
  });

  it("Regime LH when last3 high+low both BELOW prev3 high+low", () => {
    const { regime } = buildLlmTraderContext(makeContext({ dailyBars: makeDailyBars("LH") }));
    expect(regime).toBe("LH");
  });

  it("Regime RANGING when neither HH nor LH pattern holds", () => {
    const { regime } = buildLlmTraderContext(
      makeContext({ dailyBars: makeDailyBars("RANGING") })
    );
    expect(regime).toBe("RANGING");
  });

  it("Regime 'n/a' when dailyBars.length < 21 (insufficient data)", () => {
    const { regime, userMessage } = buildLlmTraderContext(
      makeContext({ dailyBars: makeDailyBars("HH", 15) }) // only 15 bars
    );
    expect(regime).toBe("n/a");
    expect(userMessage).toContain("daily: n/a");
  });
});

// ======================================================================
// buildLlmTraderContext — userMessage shape
// ======================================================================

describe("buildLlmTraderContext — userMessage shape", () => {
  it("userMessage starts with currentTimestamp prefix (first 16 chars)", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({ currentTimestamp: "2026-06-22T16:00:00Z" })
    );
    expect(userMessage.startsWith("2026-06-22T16:00")).toBe(true);
  });

  it("userMessage ends with 'Decide.' (action-prompt marker)", () => {
    const { userMessage } = buildLlmTraderContext(makeContext());
    expect(userMessage.endsWith("Decide.")).toBe(true);
  });

  it("'FLAT.' inserted when no position present", () => {
    const { userMessage } = buildLlmTraderContext(makeContext({ position: null }));
    expect(userMessage).toContain("Position: FLAT.");
  });

  it("Position context shows side, entry price, current price, P&L%", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        position: {
          side: "long",
          entryPrice: 3000,
          entryDate: "2026-06-22T08:00:00Z",
          stopPrice: 2985,
          targetPrice: 3045,
        },
        bars: makeBars(20, "2026-06-22T16:00:00Z", () => ({ close: 3030 })),
      })
    );
    expect(userMessage).toContain("LONG from 3000");
    expect(userMessage).toMatch(/cur 3030/);
    expect(userMessage).toMatch(/\+1\.00%/); // (3030-3000)/3000 * 100 = 1%
    expect(userMessage).toContain("SL 2985");
    expect(userMessage).toContain("TP 3045");
  });
});

describe("buildLlmTraderContext — R-multiple (BE-move 1R anchor)", () => {
  it("R-multiple uses initialStopPrice (preserved 1R anchor for BE-moved trades)", () => {
    // Entry 3000, current 3015. Original SL 2985 (risk=15). BE-moved SL is now 3000.
    // R should use initialSL: (3015-3000)/(3000-2985) = +1.00, NOT (3015-3000)/(3000-3000) = ∞
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        position: {
          side: "long",
          entryPrice: 3000,
          entryDate: "2026-06-22T08:00:00Z",
          stopPrice: 3000, // BE-moved
          initialStopPrice: 2985, // original 1R anchor
        },
        bars: makeBars(20, "2026-06-22T16:00:00Z", () => ({ close: 3015 })),
      })
    );
    expect(userMessage).toMatch(/R \+1\.00/);
    expect(userMessage).toContain("+1R at 3015"); // entry + slDistance
  });

  it("Falls back to stopPrice when initialStopPrice absent (legacy pre-migration-00032 rows)", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        position: {
          side: "long",
          entryPrice: 3000,
          entryDate: "2026-06-22T08:00:00Z",
          stopPrice: 2985,
          // initialStopPrice intentionally absent
        },
        bars: makeBars(20, "2026-06-22T16:00:00Z", () => ({ close: 3015 })),
      })
    );
    expect(userMessage).toMatch(/R \+1\.00/);
  });

  it("R tag OMITTED when stopPrice equals entryPrice (avoids div-by-zero) AND no initial fallback", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        position: {
          side: "long",
          entryPrice: 3000,
          entryDate: "2026-06-22T08:00:00Z",
          stopPrice: 3000, // BE-moved AND no original
        },
        bars: makeBars(20, "2026-06-22T16:00:00Z", () => ({ close: 3015 })),
      })
    );
    // R section should be absent (degenerate case — would be Infinity)
    expect(userMessage).not.toMatch(/R \+|R -/);
  });
});

describe("buildLlmTraderContext — DXY context", () => {
  it("DXY: 'n/a' when eurusdBars null or empty", () => {
    const { userMessage: u1 } = buildLlmTraderContext(makeContext({ dxyBars: null }));
    expect(u1).toContain("DXY: n/a");
    const { userMessage: u2 } = buildLlmTraderContext(makeContext({ dxyBars: [] }));
    expect(u2).toContain("DXY: n/a");
  });

  it("DXY: shows 24h + 7d %change (inverted from EUR/USD)", () => {
    // EUR/USD up 1% → DXY down ~1% (inverted)
    const eurBars = makeBars(200, "2026-06-22T16:00:00Z", (i) => ({
      close: 1.08 + i * 0.0001, // tiny rise
    }));
    const { userMessage } = buildLlmTraderContext(makeContext({ dxyBars: eurBars }));
    expect(userMessage).toMatch(/DXY: 24h -?[\d.]+% \/ 7d -?[\d.]+%/);
  });
});

describe("buildLlmTraderContext — intermarket", () => {
  it("Intermarket: 'n/a' when absent", () => {
    const { userMessage } = buildLlmTraderContext(makeContext({ intermarket: undefined }));
    expect(userMessage).toContain("Intermarket: n/a");
  });

  it("Intermarket: surfaces XAU/XAG ratio + silver 7d %change when silver bars present", () => {
    const silver = makeBars(200, "2026-06-22T16:00:00Z", (i) => ({ close: 40 + i * 0.01 }));
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        intermarket: { silver },
      })
    );
    expect(userMessage).toMatch(/XAU\/XAG \d+/);
    expect(userMessage).toMatch(/silver 7d/);
  });
});

describe("buildLlmTraderContext — Layer 3 reflection + higherTfBars", () => {
  it("recentOutcomes line included when provided", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        recentOutcomes: "last 20 trades: 65% WR, +2.5R avg",
      })
    );
    expect(userMessage).toContain("last 20 trades: 65% WR, +2.5R avg");
  });

  it("recentOutcomes line OMITTED when null (warm-up phase, <10 trades)", () => {
    const { userMessage } = buildLlmTraderContext(makeContext({ recentOutcomes: null }));
    expect(userMessage).not.toContain("last 20 trades");
  });

  it("higherTfBars: Higher TF line included when ≥1 TF has ≥8 bars", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        higherTfBars: [
          { tfLabel: "1h", bars: makeBars(20, "2026-06-22T16:00:00Z") },
        ],
      })
    );
    expect(userMessage).toContain("Higher TF: 1h:");
  });

  it("higherTfBars: TF SKIPPED when bars.length < 8", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({
        higherTfBars: [
          { tfLabel: "1h", bars: makeBars(5, "2026-06-22T16:00:00Z") }, // too few
        ],
      })
    );
    // Section silently absent
    expect(userMessage).not.toContain("Higher TF:");
  });

  it("higherTfBars: empty array → section omitted", () => {
    const { userMessage } = buildLlmTraderContext(
      makeContext({ higherTfBars: [] })
    );
    expect(userMessage).not.toContain("Higher TF:");
  });
});

// ======================================================================
// evaluateLlmTrader — provider routing + retry
// ======================================================================

describe("evaluateLlmTrader — provider routing", () => {
  it("Provider='anthropic' → routes to Anthropic client", async () => {
    const a = makeAnthropicMock({
      responses: [
        JSON.stringify({ decision: "enter_long", confidence: 75, reasoning: "FVG retest" }),
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const result = await evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    expect(a.client.messages.create).toHaveBeenCalledOnce();
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe(ANTHROPIC_HAIKU_MODEL); // default
    expect(result.decision).toEqual({
      decision: "enter_long",
      confidence: 75,
      reasoning: "FVG retest",
    });
  });

  it("Provider='groq' → routes to Groq client", async () => {
    const g = makeGroqMock({
      responses: [
        JSON.stringify({ decision: "hold", confidence: 50, reasoning: "no edge" }),
      ],
    });
    mockedGetAI.mockReturnValue(g.client as unknown as ReturnType<typeof getAIClient>);
    const result = await evaluateLlmTrader(
      { enabled: true, provider: "groq" },
      makeContext()
    );
    expect(g.client.chat.completions.create).toHaveBeenCalledOnce();
    expect(result.provider).toBe("groq");
    expect(result.model).toBe(AI_MODEL);
  });

  it("Result carries full evaluation shape (decision + regime + userMessage + provenance)", async () => {
    const a = makeAnthropicMock({
      responses: [
        JSON.stringify({ decision: "exit", confidence: 80, reasoning: "structure break" }),
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const result = await evaluateLlmTrader(
      { enabled: true, provider: "anthropic", prompt_version: "v5_15m", model: "custom-model" },
      makeContext()
    );
    expect(result).toMatchObject({
      decision: { decision: "exit", confidence: 80, reasoning: "structure break" },
      regime: expect.stringMatching(/HH|LH|RANGING|n\/a/),
      promptVersion: "v5_15m",
      provider: "anthropic",
      model: "custom-model", // honour config override
    });
    expect(typeof result.userMessage).toBe("string");
    expect(result.userMessage.endsWith("Decide.")).toBe(true);
  });
});

describe("evaluateLlmTrader — retry on transient failure", () => {
  it("First call rejects → retry succeeds → returns the retry's decision", async () => {
    vi.useFakeTimers();
    const a = makeAnthropicMock({
      responses: [
        new Error("rate limit 429"), // first throws
        JSON.stringify({ decision: "enter_long", confidence: 65, reasoning: "retry win" }),
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const promise = evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    // Advance the 1500ms backoff
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(a.client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.decision?.reasoning).toBe("retry win");
  });

  it("First call returns unparseable → retry succeeds → decision returned", async () => {
    vi.useFakeTimers();
    const a = makeAnthropicMock({
      responses: [
        "totally not JSON", // first parse fail → null → retry
        JSON.stringify({ decision: "hold", confidence: 40, reasoning: "ok now" }),
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const promise = evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(a.client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.decision?.decision).toBe("hold");
  });

  it("Both calls fail → decision: null (retry-exhausted)", async () => {
    vi.useFakeTimers();
    const a = makeAnthropicMock({
      responses: [
        new Error("rate limit"),
        new Error("still rate-limited"),
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const promise = evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(a.client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.decision).toBeNull();
    // Other fields still populated (audit log can still record the attempt)
    expect(result.userMessage).toBeDefined();
    expect(result.regime).toBeDefined();
  });

  it("Both calls return unparseable text → decision: null (extractJson exhausted)", async () => {
    vi.useFakeTimers();
    const a = makeAnthropicMock({
      responses: ["garbage", "still garbage"],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const promise = evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(result.decision).toBeNull();
  });
});

// ======================================================================
// extractJson — via evaluateLlmTrader end-to-end
// ======================================================================

describe("extractJson (via evaluateLlmTrader)", () => {
  it("Plain JSON response parses cleanly", async () => {
    const a = makeAnthropicMock({
      responses: [
        '{"decision":"enter_long","confidence":70,"reasoning":"plain"}',
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const r = await evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    expect(r.decision?.reasoning).toBe("plain");
  });

  it("```json fenced wrapper STRIPPED + inner parsed", async () => {
    const a = makeAnthropicMock({
      responses: [
        '```json\n{"decision":"enter_short","confidence":80,"reasoning":"fenced"}\n```',
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const r = await evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    expect(r.decision?.reasoning).toBe("fenced");
  });

  it("Greedy {...} extraction works when text contains prose + JSON", async () => {
    const a = makeAnthropicMock({
      responses: [
        'Based on the daily bias and FVG retest, my decision is:\n\n{"decision":"hold","confidence":50,"reasoning":"greedy"}\n\nThanks for asking.',
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const r = await evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    expect(r.decision?.reasoning).toBe("greedy");
  });

  it("Truncated fenced wrapper (no closing ```) still recovered via inner match", async () => {
    vi.useFakeTimers();
    const a = makeAnthropicMock({
      responses: [
        // Truncated ```json wrapper (no closing fence)
        '```json\n{"decision":"hold","confidence":50,"reasoning":"truncated"}',
        // Second attempt to satisfy retry path if first parsed succeeds we won't get here
        "garbage",
      ],
    });
    mockedGetAnthropic.mockReturnValue(a.client as unknown as ReturnType<typeof getAnthropicClient>);
    const promise = evaluateLlmTrader(
      { enabled: true, provider: "anthropic" },
      makeContext()
    );
    await vi.advanceTimersByTimeAsync(1500);
    const r = await promise;
    // The fence-match regex handles unterminated fences (capture group
    // is `(?:```|$)`) so the inner JSON IS recovered on the first try.
    expect(r.decision?.reasoning).toBe("truncated");
  });
});
