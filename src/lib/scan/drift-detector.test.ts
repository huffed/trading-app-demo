/**
 * Unit tests for the performance-drift detector (CB.T1.6, 2026-06-22 EVE).
 *
 * Module compares recent live trade stats to the algorithm's backtest
 * baseline and flags when the edge has decayed. Silent failure mode =
 * algorithm continues trading after the regime has broken its setup,
 * bleeding the account.
 *
 * Two public functions:
 *
 *  1. detectDrift — pure-query: reads metrics_reset_at + recent closed
 *     trades, computes recent WR / net P&L, classifies severity.
 *  2. executeDriftHalt — side-effects: disable live_trading + insert
 *     activity_log row.
 *
 * Internal `classifyDriftSeverity` is tested via detectDrift end-to-end
 * (priority-ordered: minLiveWrPct floor > 20pp WR drop > sign-flip > 15pp warn).
 *
 * Coverage (~25 tests):
 *
 *  detectDrift no-action paths (4):
 *   - baseline=null → severity:"none", reason mentions "No backtest baseline"
 *   - trades below minTrades → "none", reason cites count
 *   - empty rows + minTrades=10 → "none"
 *   - within range (no drift) → "none" with summary string
 *
 *  Halt classifications in priority order (4):
 *   - minLiveWrPct floor breached (HIGHEST PRIORITY)
 *   - wrDrop ≥ 20pp (HALT_WR_DROP_PP)
 *   - Sign flip: baseline positive + recent negative
 *   - Warn threshold met → "warn" (only if no halt triggered)
 *
 *  Priority composition (3):
 *   - Floor breach beats wrDrop halt (both eligible → floor wins)
 *   - wrDrop halt beats sign-flip halt (both eligible → wrDrop wins)
 *   - Sign-flip halt beats warn (both eligible → halt wins)
 *
 *  Math correctness (3):
 *   - win_rate = (wins / trades) × 100 (wins = pnl > 0 strict)
 *   - net_pnl = sum of realized_pnl
 *   - null realized_pnl coerced to 0 (and doesn't count as a win)
 *
 *  metrics_reset_at branch (3):
 *   - reset_at=null → query has NO .gte filter
 *   - reset_at present → query gets .gte("closed_at", resetAt)
 *   - reset_at fetched from algorithms.select("metrics_reset_at").eq("id",X).single()
 *
 *  Defaults + config (2):
 *   - DEFAULT_DRIFT_CONFIG applied when caller omits config (minTrades=10, lookback=25)
 *   - Custom config overrides defaults (minTrades=5, lookback=50)
 *
 *  Query construction (2):
 *   - paper_positions select+filters+order+limit
 *   - executeDriftHalt: algorithms.update + activity_log.insert payloads
 *
 *  executeDriftHalt (4):
 *   - Updates algorithms.live_trading_enabled=false eq id
 *   - Inserts activity_log with full result payload
 *   - insert payload includes severity + reason + recent + baseline
 *   - Sequential: update then insert (not parallel)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BacktestResults } from "@/types/algorithm";
import {
  DEFAULT_DRIFT_CONFIG,
  detectDrift,
  type DriftConfig,
  executeDriftHalt,
} from "./drift-detector";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Supabase mock that dispatches by table. -------------------------
type ClosedRowShape = { realized_pnl: number | null };
type ResetRowShape = { metrics_reset_at: string | null };

interface SupabaseMockBag {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedAlgoSelect: { cols: string | null; eq: [string, unknown] | null } | null;
  capturedPaperQuery: {
    select: string | null;
    eq: Array<[string, unknown]>;
    not: Array<[string, string, unknown]>;
    order: [string, { ascending: boolean }] | null;
    limit: number | null;
    gte: [string, unknown] | null;
  } | null;
  capturedAlgoUpdate: { payload: unknown; eq: [string, unknown] | null } | null;
  capturedActivityLogInsert: { payload: unknown } | null;
  activityLogInsertOrder: string[]; // tracks side-effect ordering
}

function makeDriftSupabaseMock(opts: {
  resetRow?: ResetRowShape | null;
  closedRows?: ClosedRowShape[];
} = {}): SupabaseMockBag {
  let capturedAlgoSelect: SupabaseMockBag["capturedAlgoSelect"] = null;
  let capturedPaperQuery: SupabaseMockBag["capturedPaperQuery"] = null;
  let capturedAlgoUpdate: SupabaseMockBag["capturedAlgoUpdate"] = null;
  let capturedActivityLogInsert: SupabaseMockBag["capturedActivityLogInsert"] = null;
  const activityLogInsertOrder: string[] = [];

  // Builder for algorithms — handles both .select.eq.single (read) and .update.eq (write).
  function makeAlgoBuilder() {
    return {
      select: vi.fn().mockImplementation((cols: string) => {
        const sel = { cols, eq: null as [string, unknown] | null };
        capturedAlgoSelect = sel;
        return {
          eq: vi.fn().mockImplementation((col: string, val: unknown) => {
            sel.eq = [col, val];
            return {
              single: vi.fn().mockResolvedValue({
                data: opts.resetRow ?? null,
                error: null,
              }),
            };
          }),
        };
      }),
      update: vi.fn().mockImplementation((payload: unknown) => {
        const upd = { payload, eq: null as [string, unknown] | null };
        capturedAlgoUpdate = upd;
        activityLogInsertOrder.push("algorithms.update");
        return {
          eq: vi.fn().mockImplementation((col: string, val: unknown) => {
            upd.eq = [col, val];
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    };
  }

  // Builder for paper_positions — chain: select.eq.eq.not.order.limit[.gte]
  // .limit returns the builder itself (thenable), since gte can be tacked
  // on AFTER limit per the source code's pattern.
  function makePaperBuilder() {
    const captured: NonNullable<SupabaseMockBag["capturedPaperQuery"]> = {
      select: null,
      eq: [],
      not: [],
      order: null,
      limit: null,
      gte: null,
    };
    capturedPaperQuery = captured;

    const builder: Record<string, unknown> = {};
    builder.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.eq.push([col, val]);
      return builder;
    });
    builder.not = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
      captured.not.push([col, op, val]);
      return builder;
    });
    builder.order = vi.fn().mockImplementation((col: string, params: { ascending: boolean }) => {
      captured.order = [col, params];
      return builder;
    });
    builder.limit = vi.fn().mockImplementation((n: number) => {
      captured.limit = n;
      return builder;
    });
    builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
      captured.gte = [col, val];
      return builder;
    });
    builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: opts.closedRows ?? [], error: null }).then(onful, onrej);
    return {
      select: vi.fn().mockImplementation((cols: string) => {
        captured.select = cols;
        return builder;
      }),
    };
  }

  // Builder for activity_log — insert only.
  function makeActivityLogBuilder() {
    return {
      insert: vi.fn().mockImplementation((payload: unknown) => {
        capturedActivityLogInsert = { payload };
        activityLogInsertOrder.push("activity_log.insert");
        return Promise.resolve({ data: null, error: null });
      }),
    };
  }

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "algorithms") return makeAlgoBuilder();
    if (table === "paper_positions") return makePaperBuilder();
    if (table === "activity_log") return makeActivityLogBuilder();
    throw new Error(`Unexpected table: ${table}`);
  });

  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    get capturedAlgoSelect() {
      return capturedAlgoSelect;
    },
    get capturedPaperQuery() {
      return capturedPaperQuery;
    },
    get capturedAlgoUpdate() {
      return capturedAlgoUpdate;
    },
    get capturedActivityLogInsert() {
      return capturedActivityLogInsert;
    },
    activityLogInsertOrder,
  };
}

// ---- Fixture helpers. -------------------------------------------------
function makeBaseline(overrides: Partial<BacktestResults> = {}): BacktestResults {
  return {
    win_rate: 60,
    total_return: 1000,
    total_trades: 100,
    sharpe_ratio: 1.5,
    max_drawdown: 5,
    profit_factor: 1.8,
    ...overrides,
  } as BacktestResults;
}

function losses(n: number): ClosedRowShape[] {
  return Array.from({ length: n }, () => ({ realized_pnl: -10 }));
}
function wins(n: number): ClosedRowShape[] {
  return Array.from({ length: n }, () => ({ realized_pnl: 20 }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ======================================================================
// detectDrift — no-action paths
// ======================================================================

describe("detectDrift — no-action paths", () => {
  it("baseline=null → severity:'none', reason mentions 'No backtest baseline'", async () => {
    const { supabase, fromMock } = makeDriftSupabaseMock();
    const r = await detectDrift(supabase, "algo-1", null);
    expect(r.severity).toBe("none");
    expect(r.reason).toContain("No backtest baseline");
    expect(r.baseline).toEqual({ win_rate: null, total_return: null });
    expect(fromMock).not.toHaveBeenCalled(); // short-circuit
  });

  it("trades below minTrades → severity:'none', reason cites count", async () => {
    const { supabase } = makeDriftSupabaseMock({
      closedRows: losses(5), // 5 < default minTrades=10
    });
    const r = await detectDrift(supabase, "algo-1", makeBaseline());
    expect(r.severity).toBe("none");
    expect(r.reason).toContain("Only 5 closed live trades");
    expect(r.reason).toContain("need ≥10");
    expect(r.recent.trades).toBe(5);
  });

  it("empty rows → severity:'none', recent.trades=0", async () => {
    const { supabase } = makeDriftSupabaseMock({ closedRows: [] });
    const r = await detectDrift(supabase, "algo-1", makeBaseline());
    expect(r.severity).toBe("none");
    expect(r.recent.trades).toBe(0);
  });

  it("within range (no drift triggers) → severity:'none' with summary string", async () => {
    // baseline WR=60, recent = 14W + 6L over 20 trades = 70% WR; +10pp ABOVE baseline → no drift
    const rows = [...wins(14), ...losses(6)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }));
    expect(r.severity).toBe("none");
    expect(r.reason).toContain("Within range");
    expect(r.reason).toContain("70% WR");
    expect(r.reason).toContain("60%");
  });
});

// ======================================================================
// detectDrift — halt + warn classification
// ======================================================================

describe("detectDrift — severity classifications", () => {
  it("minLiveWrPct floor breached → severity:'halt' with floor in reason", async () => {
    // 15 wins / 5 losses... wait need to engineer below 22% WR
    // 4 wins / 16 losses = 20% recent WR; floor=22 → breach
    const rows = [...wins(4), ...losses(16)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const config: DriftConfig = { minTrades: 10, lookbackTrades: 25, minLiveWrPct: 22 };
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 30 }), config);
    expect(r.severity).toBe("halt");
    expect(r.reason).toContain("WR floor breached");
    expect(r.reason).toContain("20% < floor 22%");
  });

  it("wrDrop ≥ 20pp (HALT) → severity:'halt' with drift reason", async () => {
    // baseline 60% WR; recent 8W/12L = 40% WR; drop = 20pp → halt
    const rows = [...wins(8), ...losses(12)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }));
    expect(r.severity).toBe("halt");
    expect(r.reason).toContain("Severe WR drift");
    expect(r.reason).toContain("40%");
    expect(r.reason).toContain("60%");
    expect(r.reason).toContain("-20pp");
  });

  it("sign flip (baseline +$, recent -$) → severity:'halt'", async () => {
    // baseline +$1000; recent: 11W +$220 / 9L -$90 = +$130 wait need negative.
    // 7 wins ($20 ea = $140) + 13 losses ($10 ea = -$130) over 20 trades
    // = 35% WR, +$10 net. Need negative net. Use 6W/14L: +$120 - $140 = -$20.
    // 6/20 = 30% WR; baseline 30% WR → no wr drift → sign-flip catches it.
    const rows = [...wins(6), ...losses(14)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 30, total_return: 1000 }));
    expect(r.severity).toBe("halt");
    expect(r.reason).toContain("Sign flip");
    expect(r.reason).toContain("+$1000");
    expect(r.reason).toContain("$-20");
  });

  it("wrDrop ≥ 15pp (WARN, < HALT threshold) → severity:'warn'", async () => {
    // baseline 60% WR; recent 9W/11L = 45% WR; drop = 15pp → warn
    const rows = [...wins(9), ...losses(11)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }));
    expect(r.severity).toBe("warn");
    expect(r.reason).toContain("WR drift");
    expect(r.reason).toContain("45%");
    expect(r.reason).toContain("60%");
    expect(r.reason).toContain("-15pp");
  });
});

// ======================================================================
// detectDrift — priority composition (which verdict wins when multiple fire)
// ======================================================================

describe("detectDrift — severity priority ordering", () => {
  it("minLiveWrPct floor beats wrDrop halt (both eligible)", async () => {
    // Both trigger: 4W/16L = 20% recent, baseline 60% → wrDrop=40pp (halt) AND floor=22 breach
    const rows = [...wins(4), ...losses(16)];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const config: DriftConfig = { minTrades: 10, lookbackTrades: 25, minLiveWrPct: 22 };
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }), config);
    expect(r.severity).toBe("halt");
    expect(r.reason).toContain("WR floor breached"); // floor wins over wrDrop
    expect(r.reason).not.toContain("Severe WR drift");
  });

  it("wrDrop halt beats sign-flip halt (both eligible)", async () => {
    // baseline 60% WR, +$1000 return; recent 8W/12L = 40% (-20pp halt) + net -$40 (sign flip)
    // 8 wins × $20 = $160; 12 losses × $20 = -$240; net = -$80 (sign flip from +1000)
    const rows = [...wins(8), ...Array.from({ length: 12 }, () => ({ realized_pnl: -20 }))];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60, total_return: 1000 }));
    expect(r.severity).toBe("halt");
    expect(r.reason).toContain("Severe WR drift"); // wrDrop reasoning wins
    expect(r.reason).not.toContain("Sign flip");
  });

  it("sign-flip halt beats warn (both eligible)", async () => {
    // baseline 60% WR, +1000; recent 9W/11L = 45% WR → -15pp warn + net negative → sign-flip halt
    // 9 wins × $20 = $180; 11 losses × $20 = -$220; net = -$40 (sign flip from +1000)
    const rows = [...wins(9), ...Array.from({ length: 11 }, () => ({ realized_pnl: -20 }))];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60, total_return: 1000 }));
    expect(r.severity).toBe("halt"); // sign-flip wins over warn
    expect(r.reason).toContain("Sign flip");
  });
});

// ======================================================================
// detectDrift — math correctness
// ======================================================================

describe("detectDrift — math correctness", () => {
  it("win_rate = (wins / trades) × 100 — pnl > 0 strict (BE is NOT a win)", async () => {
    // 10 trades: 7 wins, 1 BE (pnl=0), 2 losses → wins = 7, WR = 70%
    const rows: ClosedRowShape[] = [
      ...wins(7),
      { realized_pnl: 0 }, // BE, not a win
      ...losses(2),
    ];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }));
    expect(r.recent.win_rate).toBe(70);
    expect(r.recent.trades).toBe(10);
  });

  it("net_pnl = sum of realized_pnl across all rows", async () => {
    // 5 × $20 + 5 × -$10 = $50
    const { supabase } = makeDriftSupabaseMock({ closedRows: [...wins(5), ...losses(5)] });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 50 }));
    expect(r.recent.net_pnl).toBe(50);
  });

  it("null realized_pnl coerced to 0 (and not counted as win)", async () => {
    // 6 wins + 4 nulls = 10 trades, wins=6, net = 6×20 + 0 = 120
    const rows: ClosedRowShape[] = [
      ...wins(6),
      ...Array.from({ length: 4 }, () => ({ realized_pnl: null })),
    ];
    const { supabase } = makeDriftSupabaseMock({ closedRows: rows });
    const r = await detectDrift(supabase, "algo-1", makeBaseline({ win_rate: 60 }));
    expect(r.recent.win_rate).toBe(60); // 6 / 10
    expect(r.recent.net_pnl).toBe(120);
  });
});

// ======================================================================
// detectDrift — metrics_reset_at branch
// ======================================================================

describe("detectDrift — metrics_reset_at handling", () => {
  it("reset_at=null → query has NO .gte filter", async () => {
    const conf = makeDriftSupabaseMock({
      resetRow: { metrics_reset_at: null },
      closedRows: losses(15),
    });
    await detectDrift(conf.supabase, "algo-1", makeBaseline());
    expect(conf.capturedPaperQuery?.gte).toBeNull();
  });

  it("reset_at present → query gets .gte('closed_at', resetAt)", async () => {
    const conf = makeDriftSupabaseMock({
      resetRow: { metrics_reset_at: "2026-06-01T00:00:00Z" },
      closedRows: losses(15),
    });
    await detectDrift(conf.supabase, "algo-1", makeBaseline());
    expect(conf.capturedPaperQuery?.gte).toEqual(["closed_at", "2026-06-01T00:00:00Z"]);
  });

  it("metrics_reset_at fetched from algorithms.select.eq(id).single()", async () => {
    const conf = makeDriftSupabaseMock({
      resetRow: { metrics_reset_at: "2026-06-01T00:00:00Z" },
    });
    await detectDrift(conf.supabase, "algo-XYZ", makeBaseline());
    expect(conf.capturedAlgoSelect?.cols).toBe("metrics_reset_at");
    expect(conf.capturedAlgoSelect?.eq).toEqual(["id", "algo-XYZ"]);
  });
});

// ======================================================================
// detectDrift — defaults + config + query construction
// ======================================================================

describe("detectDrift — defaults + config + query construction", () => {
  it("DEFAULT_DRIFT_CONFIG: minTrades=10, lookbackTrades=25", () => {
    expect(DEFAULT_DRIFT_CONFIG.minTrades).toBe(10);
    expect(DEFAULT_DRIFT_CONFIG.lookbackTrades).toBe(25);
  });

  it("default config applied → limit(25) used in paper_positions query", async () => {
    const conf = makeDriftSupabaseMock({ closedRows: [] });
    await detectDrift(conf.supabase, "algo-1", makeBaseline()); // no config arg
    expect(conf.capturedPaperQuery?.limit).toBe(25);
  });

  it("custom config overrides: minTrades=5, lookbackTrades=50", async () => {
    const conf = makeDriftSupabaseMock({ closedRows: losses(8) });
    const config: DriftConfig = { minTrades: 5, lookbackTrades: 50 };
    const r = await detectDrift(conf.supabase, "algo-1", makeBaseline({ win_rate: 60 }), config);
    // 8 trades >= 5 minTrades → evaluation proceeds (default would have returned "need ≥10")
    expect(r.recent.trades).toBe(8);
    expect(r.severity).not.toBe("none"); // 8L=0% WR vs 60% baseline → halt
    expect(conf.capturedPaperQuery?.limit).toBe(50);
  });

  it("paper_positions query: select+filters+order+limit construction", async () => {
    const conf = makeDriftSupabaseMock({ closedRows: [] });
    await detectDrift(conf.supabase, "algo-1", makeBaseline());
    expect(conf.capturedPaperQuery?.select).toBe("realized_pnl");
    expect(conf.capturedPaperQuery?.eq).toEqual([
      ["algorithm_id", "algo-1"],
      ["status", "closed"],
    ]);
    expect(conf.capturedPaperQuery?.not).toEqual([["realized_pnl", "is", null]]);
    expect(conf.capturedPaperQuery?.order).toEqual(["closed_at", { ascending: false }]);
    expect(conf.capturedPaperQuery?.limit).toBe(25);
  });
});

// ======================================================================
// executeDriftHalt — side effects
// ======================================================================

describe("executeDriftHalt — side effects", () => {
  const result = {
    severity: "halt" as const,
    reason: "Sign flip: backtest +$1000 but recent 20 trades net $-50",
    recent: { trades: 20, win_rate: 30, net_pnl: -50 },
    baseline: { win_rate: 60, total_return: 1000 },
  };

  it("updates algorithms.live_trading_enabled=false eq id", async () => {
    const conf = makeDriftSupabaseMock();
    await executeDriftHalt(conf.supabase, "user-1", "algo-1", result);
    expect(conf.capturedAlgoUpdate?.payload).toEqual({ live_trading_enabled: false });
    expect(conf.capturedAlgoUpdate?.eq).toEqual(["id", "algo-1"]);
  });

  it("inserts activity_log row with user_id + algo_id + drift_halt event_type", async () => {
    const conf = makeDriftSupabaseMock();
    await executeDriftHalt(conf.supabase, "user-1", "algo-1", result);
    expect(conf.capturedActivityLogInsert?.payload).toMatchObject({
      user_id: "user-1",
      algorithm_id: "algo-1",
      event_type: "drift_halt",
    });
  });

  it("activity_log details payload includes severity + reason + recent + baseline", async () => {
    const conf = makeDriftSupabaseMock();
    await executeDriftHalt(conf.supabase, "user-1", "algo-1", result);
    const insertPayload = conf.capturedActivityLogInsert?.payload as { details: unknown };
    expect(insertPayload.details).toEqual({
      severity: "halt",
      reason: "Sign flip: backtest +$1000 but recent 20 trades net $-50",
      recent: { trades: 20, win_rate: 30, net_pnl: -50 },
      baseline: { win_rate: 60, total_return: 1000 },
    });
  });

  it("sequential: algorithms.update fires BEFORE activity_log.insert", async () => {
    const conf = makeDriftSupabaseMock();
    await executeDriftHalt(conf.supabase, "user-1", "algo-1", result);
    expect(conf.activityLogInsertOrder).toEqual(["algorithms.update", "activity_log.insert"]);
  });
});
