/**
 * Unit tests for checkExitTrigger (CB.T1 + CB.H1 hybrid pass, 2026-06-22).
 * Extracted from scan/engine.ts so the pure exit-trigger function can be
 * unit-tested independently of the scan/manage orchestrators.
 *
 * Tests every priority branch + side-mirror semantics + the condition-
 * based exit path (with the shared evaluate module mocked) + the daily-
 * bars fallback to resampleToDaily.
 *
 * Coverage (~22 tests):
 *  Priority + side semantics:
 *   - SL takes precedence over TP (when both would trigger same tick)
 *   - SL takes precedence over exit conditions
 *   - TP takes precedence over exit conditions
 *
 *  Stop-loss:
 *   - long: hit when currentPrice <= stop_loss_price (inclusive)
 *   - long: NOT hit when currentPrice > stop_loss_price
 *   - short: hit when currentPrice >= stop_loss_price (mirrored, inclusive)
 *   - short: NOT hit when currentPrice < stop_loss_price
 *   - stop_loss_price=null → SL check skipped
 *
 *  Take-profit:
 *   - long: hit when currentPrice >= take_profit_price (inclusive)
 *   - long: NOT hit when currentPrice < take_profit_price
 *   - short: hit when currentPrice <= take_profit_price (mirrored, inclusive)
 *   - short: NOT hit when currentPrice > take_profit_price
 *   - take_profit_price=null → TP check skipped
 *
 *  Exit conditions (mocked checkConditions):
 *   - No exit_conditions → "exit_signal" never fires
 *   - Empty after type-filter (sentiment-only) → "exit_signal" never fires
 *   - checkConditions returns true → "exit_signal" returned
 *   - checkConditions returns false → null returned
 *   - exit_logic override used when present
 *   - falls back to entry_logic when exit_logic absent
 *   - daily_bars provided → passed as higherTfBars (no resample)
 *   - daily_bars null → resampleToDaily called as fallback
 *
 *  Return semantics:
 *   - Returns null when nothing triggers (no SL/TP/exit-condition hit)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkConditions, normalize } from "@/lib/conditions/evaluate";
import { resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { checkExitTrigger } from "./exit-trigger";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/conditions/evaluate", () => ({
  checkConditions: vi.fn(),
  normalize: vi.fn((conds) => conds ?? []),
}));
vi.mock("@/lib/market-data/resample", () => ({
  resampleToDaily: vi.fn().mockReturnValue([]),
}));

const mockedCheckConditions = vi.mocked(checkConditions);
const mockedNormalize = vi.mocked(normalize);
const mockedResampleToDaily = vi.mocked(resampleToDaily);

// ---- Fixture builders. ------------------------------------------------
function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    id: "pos-1",
    user_id: "user-1",
    algorithm_id: "algo-1",
    ticker: "XAU/USD",
    side: "long",
    quantity: 1,
    entry_price: 3000,
    current_price: 3000,
    stop_loss_price: 2985,
    take_profit_price: 3045,
    status: "open",
    opened_at: "2026-06-22T08:00:00Z",
    ...overrides,
  });
  return stub as unknown as PaperPosition;
}

function makeRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    entry_logic: "all",
    ...overrides,
  } as unknown as AlgorithmRules;
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckConditions.mockReturnValue(false);
  mockedNormalize.mockImplementation((c) => (c as unknown[]) ?? []);
  mockedResampleToDaily.mockReturnValue([]);
});

// ======================================================================
// Priority semantics — SL > TP > exit-condition
// ======================================================================

describe("checkExitTrigger — priority semantics", () => {
  it("SL takes precedence over TP when both would trigger same tick", async () => {
    // Long position, currentPrice at 2980 (below SL=2985) AND we set TP=2980 so it
    // would also trigger. SL must win.
    const position = makePosition({
      stop_loss_price: 2985,
      take_profit_price: 2980,
    });
    const r = checkExitTrigger(position, 2980, makeRules(), [], [], null);
    expect(r).toBe("stop_loss");
  });

  it("SL takes precedence over exit conditions", () => {
    mockedCheckConditions.mockReturnValue(true);
    const position = makePosition({ stop_loss_price: 2985 });
    const r = checkExitTrigger(
      position,
      2980,
      makeRules({ exit_conditions: [{ type: "technical" }] as unknown as AlgorithmRules["exit_conditions"] }),
      [],
      [],
      null
    );
    expect(r).toBe("stop_loss");
    // Exit conditions weren't even evaluated (SL fired first)
    expect(mockedCheckConditions).not.toHaveBeenCalled();
  });

  it("TP takes precedence over exit conditions", () => {
    mockedCheckConditions.mockReturnValue(true);
    const position = makePosition({ take_profit_price: 3045 });
    const r = checkExitTrigger(
      position,
      3050,
      makeRules({ exit_conditions: [{ type: "technical" }] as unknown as AlgorithmRules["exit_conditions"] }),
      [],
      [],
      null
    );
    expect(r).toBe("take_profit");
    expect(mockedCheckConditions).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Stop-loss
// ======================================================================

describe("checkExitTrigger — stop loss", () => {
  it("long: HIT when currentPrice <= stop_loss_price (inclusive boundary)", () => {
    const position = makePosition({ side: "long", stop_loss_price: 2985 });
    expect(checkExitTrigger(position, 2985, makeRules(), [], [], null)).toBe("stop_loss");
    expect(checkExitTrigger(position, 2980, makeRules(), [], [], null)).toBe("stop_loss");
  });

  it("long: NOT hit when currentPrice > stop_loss_price", () => {
    const position = makePosition({ side: "long", stop_loss_price: 2985 });
    expect(checkExitTrigger(position, 2986, makeRules(), [], [], null)).toBeNull();
    expect(checkExitTrigger(position, 3000, makeRules(), [], [], null)).toBeNull();
  });

  it("short: HIT when currentPrice >= stop_loss_price (mirrored, inclusive)", () => {
    const position = makePosition({ side: "short", stop_loss_price: 3015 });
    expect(checkExitTrigger(position, 3015, makeRules(), [], [], null)).toBe("stop_loss");
    expect(checkExitTrigger(position, 3020, makeRules(), [], [], null)).toBe("stop_loss");
  });

  it("short: NOT hit when currentPrice < stop_loss_price", () => {
    // Disable TP to isolate SL semantics — short TP triggers when price <= TP,
    // so the default TP=3045 would mask SL behaviour at price=3014.
    const position = makePosition({
      side: "short",
      stop_loss_price: 3015,
      take_profit_price: null,
    });
    expect(checkExitTrigger(position, 3014, makeRules(), [], [], null)).toBeNull();
  });

  it("stop_loss_price = null → SL check skipped (no false trigger)", () => {
    // No SL set + price way below entry → SL block doesn't fire
    const position = makePosition({ side: "long", stop_loss_price: null });
    const r = checkExitTrigger(position, 1000, makeRules(), [], [], null);
    expect(r).toBeNull();
  });
});

// ======================================================================
// Take-profit
// ======================================================================

describe("checkExitTrigger — take profit", () => {
  it("long: HIT when currentPrice >= take_profit_price (inclusive boundary)", () => {
    const position = makePosition({ side: "long", take_profit_price: 3045 });
    expect(checkExitTrigger(position, 3045, makeRules(), [], [], null)).toBe("take_profit");
    expect(checkExitTrigger(position, 3050, makeRules(), [], [], null)).toBe("take_profit");
  });

  it("long: NOT hit when currentPrice < take_profit_price", () => {
    const position = makePosition({ side: "long", take_profit_price: 3045 });
    expect(checkExitTrigger(position, 3044, makeRules(), [], [], null)).toBeNull();
  });

  it("short: HIT when currentPrice <= take_profit_price (mirrored)", () => {
    const position = makePosition({ side: "short", take_profit_price: 2970 });
    expect(checkExitTrigger(position, 2970, makeRules(), [], [], null)).toBe("take_profit");
    expect(checkExitTrigger(position, 2960, makeRules(), [], [], null)).toBe("take_profit");
  });

  it("short: NOT hit when currentPrice > take_profit_price", () => {
    const position = makePosition({ side: "short", take_profit_price: 2970 });
    expect(checkExitTrigger(position, 2975, makeRules(), [], [], null)).toBeNull();
  });

  it("take_profit_price = null → TP check skipped", () => {
    const position = makePosition({ side: "long", take_profit_price: null });
    // Price way above entry but no TP set → no trigger
    const r = checkExitTrigger(position, 9999, makeRules({ exit_conditions: [] }), [], [], null);
    expect(r).toBeNull();
  });
});

// ======================================================================
// Exit conditions (mocked checkConditions)
// ======================================================================

describe("checkExitTrigger — exit-condition path", () => {
  it("No exit_conditions → 'exit_signal' never fires", () => {
    mockedCheckConditions.mockReturnValue(true); // would trigger if called
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    const r = checkExitTrigger(
      position,
      3000,
      makeRules({ exit_conditions: [] }),
      [],
      [],
      null
    );
    expect(r).toBeNull();
    expect(mockedCheckConditions).not.toHaveBeenCalled();
  });

  it("Empty after type-filter (only sentiment conditions) → exit_signal not evaluated", () => {
    // normalize returns the raw list; type-filter excludes sentiment.
    // Use a sentiment-only fixture.
    mockedNormalize.mockReturnValue([
      { type: "sentiment", topics: ["gold"] } as unknown,
    ] as unknown[]);
    mockedCheckConditions.mockReturnValue(true); // would trigger if called
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    const r = checkExitTrigger(
      position,
      3000,
      makeRules({
        exit_conditions: [
          { type: "sentiment", topics: ["gold"] } as unknown as AlgorithmRules["exit_conditions"][number],
        ],
      }),
      [],
      [],
      null
    );
    expect(r).toBeNull();
    expect(mockedCheckConditions).not.toHaveBeenCalled();
  });

  it("checkConditions returns true → 'exit_signal' returned", () => {
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockReturnValue(true);
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    const r = checkExitTrigger(
      position,
      3000,
      makeRules({
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      [],
      [3000],
      null
    );
    expect(r).toBe("exit_signal");
  });

  it("checkConditions returns false → null returned", () => {
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockReturnValue(false);
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    const r = checkExitTrigger(
      position,
      3000,
      makeRules({
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      [],
      [3000],
      null
    );
    expect(r).toBeNull();
  });

  it("exit_logic OVERRIDE used when present (preferred over entry_logic)", () => {
    let capturedLogic: unknown = null;
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockImplementation((_conds, _ctx, logic) => {
      capturedLogic = logic;
      return true;
    });
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    checkExitTrigger(
      position,
      3000,
      makeRules({
        entry_logic: "all",
        exit_logic: "any", // OVERRIDE
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      } as unknown as Partial<AlgorithmRules>),
      [],
      [3000],
      null
    );
    expect(capturedLogic).toBe("any");
  });

  it("Falls back to entry_logic when exit_logic absent", () => {
    let capturedLogic: unknown = null;
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockImplementation((_conds, _ctx, logic) => {
      capturedLogic = logic;
      return true;
    });
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    checkExitTrigger(
      position,
      3000,
      makeRules({
        entry_logic: "any",
        // exit_logic intentionally absent
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      [],
      [3000],
      null
    );
    expect(capturedLogic).toBe("any");
  });

  it("dailyBars provided → passed as higherTfBars; resampleToDaily NOT called", () => {
    let capturedHigherTf: unknown = null;
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockImplementation((_conds, ctx) => {
      capturedHigherTf = (ctx as { higherTfBars: unknown }).higherTfBars;
      return false;
    });
    const dailyBars = [makeBar("2026-06-22T00:00:00Z"), makeBar("2026-06-21T00:00:00Z")];
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    checkExitTrigger(
      position,
      3000,
      makeRules({
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      [makeBar("2026-06-22T08:00:00Z")],
      [3000],
      dailyBars
    );
    expect(capturedHigherTf).toEqual(dailyBars); // exact array passed through
    expect(mockedResampleToDaily).not.toHaveBeenCalled();
  });

  it("dailyBars = null → resampleToDaily called as fallback", () => {
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockReturnValue(false);
    const intradayBars = [makeBar("2026-06-22T08:00:00Z")];
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    checkExitTrigger(
      position,
      3000,
      makeRules({
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      intradayBars,
      [3000],
      null
    );
    expect(mockedResampleToDaily).toHaveBeenCalledWith(intradayBars);
  });
});

// ======================================================================
// Default return
// ======================================================================

describe("checkExitTrigger — null return when nothing triggers", () => {
  it("returns null when SL/TP not hit AND no exit conditions present", () => {
    const position = makePosition({
      side: "long",
      stop_loss_price: 2985,
      take_profit_price: 3045,
    });
    const r = checkExitTrigger(position, 3000, makeRules(), [], [], null);
    expect(r).toBeNull();
  });

  it("ctx.i = closes.length - 1 (current bar index passed to evaluator)", () => {
    let capturedI: unknown = null;
    mockedNormalize.mockReturnValue([{ type: "technical" } as unknown] as unknown[]);
    mockedCheckConditions.mockImplementation((_conds, ctx) => {
      capturedI = (ctx as { i: number }).i;
      return false;
    });
    const closes = [2990, 2995, 3000, 3005, 3010];
    const position = makePosition({ stop_loss_price: null, take_profit_price: null });
    checkExitTrigger(
      position,
      3010,
      makeRules({
        exit_conditions: [{ type: "technical" } as unknown as AlgorithmRules["exit_conditions"][number]],
      }),
      [],
      closes,
      null
    );
    expect(capturedI).toBe(4); // closes.length - 1
  });
});
