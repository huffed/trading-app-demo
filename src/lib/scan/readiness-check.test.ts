/**
 * Unit tests for runReadinessCheck (CB.T1 pass 15, 2026-06-22).
 * Fifteenth test in `src/lib/scan/`. Aggregate readiness verdict for
 * an algorithm — bundles walk-forward stability + pair quality +
 * side symmetry + FTMO fit into one operator-facing pass/caution/fail.
 *
 * The 4 sub-checks (walkForwardCheck, pairQualityCheck,
 * sideSymmetryCheck, ftmoFitCheck) and the combiner are NOT exported,
 * so we exercise each branch through the public runReadinessCheck API.
 *
 * Coverage (~25 tests):
 *  Setup-path dispatch:
 *   - Algo not found → {ok:false, error}
 *   - Verdict combiner: any "fail" → "fail"; any "caution" w/o fail → "caution";
 *     all "pass" → "pass"
 *
 *  walkForwardCheck branches:
 *   - total_windows < 3 → caution
 *   - green_window_rate < 70% → caution
 *   - mean_return below FTMO pace (scaled by window/180) → caution
 *   - mean_drawdown > 8% safety cap → caution
 *   - worst_dd ≥ FTMO 10% limit → FAIL (only fail branch)
 *   - worst_dd in [8, 10) → caution "within 2pp"
 *   - All clean → pass
 *
 *  LLM-trader cache dispatch:
 *   - LLM-trader algo with cache → uses cached WF (NOT runWalkForward)
 *   - LLM-trader algo WITHOUT cache → caution "DEFERRED"
 *   - Non-LLM-trader → uses runWalkForward path (cache untouched)
 *
 *  pairQualityCheck branches:
 *   - Loser: ≥8 trades + ≤30% WR → FAIL
 *   - Empty stats → caution "insufficient live trade history"
 *   - All pairs above floor → pass
 *
 *  sideSymmetryCheck branches:
 *   - side='auto' → caution (CHF/JPY short trap reference)
 *   - side='long' → pass
 *   - side undefined → pass
 *
 *  ftmoFitCheck branches:
 *   - risk_per_trade > 1% → caution
 *   - No consecutive_loss_daily_halt → caution
 *   - Both issues → caution joined with "; "
 *   - Clean → pass
 *
 *  Output shape:
 *   - Report includes algorithm_id, algorithm_name, verdict, 4 checks,
 *     walk_forward_summary with the 5 promised stats
 *   - Tickers UPPERCASED before being passed downstream
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { timeframeToInterval } from "@/lib/market-data/interval";
import {
  getCachedPrices,
  savePricesToCache,
} from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { runWalkForward } from "@/lib/market-data/walk-forward";
import { getAllPairStats } from "@/lib/scan/pair-quality";
import type { AlgorithmRules } from "@/types/algorithm";
import { runReadinessCheck } from "./readiness-check";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks. -----------------------------------------------------------
vi.mock("@/lib/market-data/interval", () => ({
  timeframeToInterval: vi.fn(),
}));
vi.mock("@/lib/market-data/price-cache", () => ({
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn(),
}));
vi.mock("@/lib/market-data/prices", () => ({
  fetchDailyPrices: vi.fn(),
}));
vi.mock("@/lib/market-data/walk-forward", () => ({
  runWalkForward: vi.fn(),
}));
vi.mock("@/lib/scan/pair-quality", () => ({
  getAllPairStats: vi.fn(),
}));

const mockedTimeframeToInterval = vi.mocked(timeframeToInterval);
const mockedGetCachedPrices = vi.mocked(getCachedPrices);
const mockedSavePricesToCache = vi.mocked(savePricesToCache);
const mockedFetchDailyPrices = vi.mocked(fetchDailyPrices);
const mockedRunWalkForward = vi.mocked(runWalkForward);
const mockedGetAllPairStats = vi.mocked(getAllPairStats);

// ---- Fixture builders. ------------------------------------------------
type AlgoRow = {
  rules: AlgorithmRules;
  capital: number;
  user_id: string;
  name: string;
  llm_walk_forward_cache: unknown | null;
};

type WfSummary = {
  total_windows: number;
  mean_win_rate: number;
  mean_return: number;
  mean_drawdown: number;
  win_rate_of_windows: number;
  windows: Array<{ total_return: number; max_drawdown: number }>;
};

function makeRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    timeframe: "4h",
    asset_class: "commodities",
    side: "long",
    position_sizing: { type: "risk_per_trade", value: 1 },
    stop_loss: { type: "percentage", value: 1.5 },
    take_profit: { type: "percentage", value: 3 },
    entry_conditions: [],
    exit_conditions: [],
    prop_firm: { consecutive_loss_daily_halt: 3 },
    ...overrides,
  } as unknown as AlgorithmRules;
}

function makeAlgo(overrides: Partial<AlgoRow> = {}): AlgoRow {
  return {
    rules: makeRules(),
    capital: 100_000,
    user_id: "user-1",
    name: "Test Algo",
    llm_walk_forward_cache: null,
    ...overrides,
  };
}

// "Clean" WF — 6 windows, 100% green, mean ret 12K (=12% on 100K cap,
// above FTMO 10% target per 180d), mean DD 3%, worst DD 4% → all
// under FTMO thresholds for the default 180d window.
function cleanWf(): WfSummary {
  return {
    total_windows: 6,
    mean_win_rate: 0.6,
    mean_return: 12_000,
    mean_drawdown: 3,
    win_rate_of_windows: 1.0,
    windows: Array.from({ length: 6 }, () => ({ total_return: 12_000, max_drawdown: 4 })),
  };
}

// ---- Supabase mock. ---------------------------------------------------
// Two reads needed:
//  1. algorithms.select(cols).eq("id",id).single()
//  2. algorithm_watchlist.select("ticker").eq("algorithm_id",id) — terminal eq

interface SupabaseReadinessOpts {
  algoData?: AlgoRow | null;
  algoError?: { message: string } | null;
  tickers?: Array<{ ticker: string }>;
}

function makeSupabaseReadinessMock(
  opts: SupabaseReadinessOpts = {}
): SupabaseClient {
  const fromMock = vi.fn((table: string) => {
    if (table === "algorithms") {
      const single = vi.fn().mockResolvedValue({
        data: opts.algoData ?? null,
        error: opts.algoError ?? null,
      });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      return { select };
    }
    if (table === "algorithm_watchlist") {
      const result = { data: opts.tickers ?? [], error: null };
      const builder = Object.create(null) as Record<string, unknown>;
      builder.eq = vi.fn().mockImplementation(() => builder);
      builder.then = (
        onfulfilled?: (v: typeof result) => unknown,
        onrejected?: (e: unknown) => unknown
      ) => Promise.resolve(result).then(onfulfilled, onrejected);
      const select = vi.fn().mockReturnValue(builder);
      return { select };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return supabaseStub as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults
  mockedTimeframeToInterval.mockReturnValue("4h");
  mockedGetCachedPrices.mockResolvedValue(null);
  mockedFetchDailyPrices.mockResolvedValue([]);
  mockedSavePricesToCache.mockResolvedValue(undefined);
  mockedRunWalkForward.mockReturnValue(cleanWf());
  mockedGetAllPairStats.mockResolvedValue(new Map());
});

// ======================================================================
// Setup-path dispatch
// ======================================================================

describe("runReadinessCheck — setup paths", () => {
  it("algo not found → {ok:false, error:'Algorithm not found'}", async () => {
    const supabase = makeSupabaseReadinessMock({ algoData: null });
    const r = await runReadinessCheck(supabase, "missing-algo");
    expect(r).toEqual({ ok: false, error: "Algorithm not found" });
  });

  it("supabase error on algo lookup → {ok:false, error}", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: null,
      algoError: { message: "permission denied" },
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    expect(r.ok).toBe(false);
  });

  it("all clean → verdict='pass', 4 checks all pass", async () => {
    mockedRunWalkForward.mockReturnValue(cleanWf());
    mockedGetAllPairStats.mockResolvedValue(
      new Map([
        ["XAU/USD", { ticker: "XAU/USD", trades: 15, wins: 9, win_rate: 0.6, net_pnl: 1000 }],
      ])
    );
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.verdict).toBe("pass");
    expect(r.report.checks).toHaveLength(4);
    expect(r.report.checks.every((c) => c.severity === "pass")).toBe(true);
  });
});

// ======================================================================
// Verdict combiner semantics (any fail → fail; any caution → caution)
// ======================================================================

describe("runReadinessCheck — verdict combiner", () => {
  it("ANY check fail → verdict='fail' (worst-severity dominates)", async () => {
    // Worst-DD fail in WF check → overall fail
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      windows: [
        { total_return: 5_000, max_drawdown: 12 }, // breaches FTMO 10% → WF fails
        { total_return: 5_000, max_drawdown: 3 },
        { total_return: 5_000, max_drawdown: 4 },
      ],
      total_windows: 3,
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.verdict).toBe("fail");
  });

  it("ANY caution + no fail → verdict='caution'", async () => {
    // side='auto' triggers side_symmetry caution; others pass
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({ rules: makeRules({ side: "auto" }) }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.verdict).toBe("caution");
  });
});

// ======================================================================
// Walk-forward check branches
// ======================================================================

describe("runReadinessCheck — walk-forward check branches", () => {
  function findCheck(checks: { name: string; severity: string; reason: string }[], name: string) {
    const c = checks.find((x) => x.name === name);
    if (!c) throw new Error(`check '${name}' missing`);
    return c;
  }

  it("total_windows < 3 → caution 'Only N window(s)'", async () => {
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      total_windows: 2,
      windows: [
        { total_return: 5_000, max_drawdown: 3 },
        { total_return: 5_000, max_drawdown: 3 },
      ],
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("caution");
    expect(wf.reason).toContain("Only 2 window(s)");
  });

  it("green_window_rate < 70% → caution mentioning green%", async () => {
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      win_rate_of_windows: 0.5, // 50% green
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("caution");
    expect(wf.reason).toContain("50% of windows green");
  });

  it("mean_return below FTMO pace (windowDays-scaled) → caution", async () => {
    // 180d window → FTMO pace 10% × 180/180 = 10%. Provide 3K mean_return on 100K = 3% → below pace.
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      mean_return: 3_000, // 3% on 100K — below 10% target
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("caution");
    expect(wf.reason).toContain("below FTMO");
  });

  it("mean_drawdown > 8% safety cap → caution", async () => {
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      mean_drawdown: 9, // > 8 cap
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("caution");
    expect(wf.reason).toContain("mean DD 9.0%");
  });

  it("worst_dd ≥ FTMO 10% limit → FAIL (the only fail branch in WF check)", async () => {
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      windows: [
        { total_return: 5_000, max_drawdown: 11 }, // breaches FTMO
        { total_return: 5_000, max_drawdown: 4 },
        { total_return: 5_000, max_drawdown: 3 },
      ],
      total_windows: 3,
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("fail");
    expect(wf.reason).toContain("breaches FTMO");
  });

  it("worst_dd in [8, 10) → caution 'within 2pp of FTMO limit'", async () => {
    mockedRunWalkForward.mockReturnValue({
      ...cleanWf(),
      windows: [
        { total_return: 5_000, max_drawdown: 9 }, // within 2pp of 10% limit
        { total_return: 5_000, max_drawdown: 4 },
        { total_return: 5_000, max_drawdown: 3 },
      ],
      total_windows: 3,
    });
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("caution");
    expect(wf.reason).toContain("within 2pp");
  });

  it("all clean → pass with descriptive evidence (windows, green%, mean ret, DDs)", async () => {
    mockedRunWalkForward.mockReturnValue(cleanWf());
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = findCheck(r.report.checks, "walk_forward_stability");
    expect(wf.severity).toBe("pass");
    expect(wf.reason).toContain("6 windows");
    expect(wf.reason).toContain("100% green");
  });
});

// ======================================================================
// LLM-trader cache dispatch
// ======================================================================

describe("runReadinessCheck — LLM-trader cache dispatch", () => {
  it("LLM-trader algo with cache → uses cached WF (NOT runWalkForward)", async () => {
    const cache = {
      generated_at: "2026-06-18T00:00:00Z",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      prompt_version: "v2",
      timeframe: "4h",
      window_days: 90, // shorter window — pace target halved
      window_count: 6,
      end_date: "2026-06-18",
      capital: 100_000,
      summary: cleanWf(),
    };
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({ llm_trader: { enabled: true } } as unknown as Partial<AlgorithmRules>),
        llm_walk_forward_cache: cache,
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    expect(mockedRunWalkForward).not.toHaveBeenCalled();
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.walk_forward_summary.windows).toBe(6);
  });

  it("LLM-trader algo WITHOUT cache → walk_forward check is caution 'DEFERRED'", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({ llm_trader: { enabled: true } } as unknown as Partial<AlgorithmRules>),
        llm_walk_forward_cache: null,
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const wf = r.report.checks.find((c) => c.name === "walk_forward_stability");
    expect(wf?.severity).toBe("caution");
    expect(wf?.reason).toContain("DEFERRED");
    // walk_forward_summary windows = 0 (zero-filled)
    expect(r.report.walk_forward_summary.windows).toBe(0);
    // runWalkForward NOT called (LLM-trader path bypasses it entirely)
    expect(mockedRunWalkForward).not.toHaveBeenCalled();
  });

  it("non-LLM-trader algo → uses runWalkForward path (cache untouched)", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({ llm_trader: undefined } as unknown as Partial<AlgorithmRules>),
      }),
    });
    await runReadinessCheck(supabase, "algo-1");
    expect(mockedRunWalkForward).toHaveBeenCalledOnce();
  });
});

// ======================================================================
// Pair quality branches
// ======================================================================

describe("runReadinessCheck — pair quality branches", () => {
  function findCheck(checks: { name: string; severity: string; reason: string }[], name: string) {
    const c = checks.find((x) => x.name === name);
    if (!c) throw new Error(`check '${name}' missing`);
    return c;
  }

  it("loser with ≥8 trades + ≤30% WR → FAIL listing the loser", async () => {
    mockedGetAllPairStats.mockResolvedValue(
      new Map([
        ["EUR/USD", { ticker: "EUR/USD", trades: 12, wins: 3, win_rate: 0.25, net_pnl: -500 }],
      ])
    );
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const pq = findCheck(r.report.checks, "pair_quality");
    expect(pq.severity).toBe("fail");
    expect(pq.reason).toContain("EUR/USD 3/12");
  });

  it("empty stats → caution 'insufficient live trade history'", async () => {
    mockedGetAllPairStats.mockResolvedValue(new Map());
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const pq = findCheck(r.report.checks, "pair_quality");
    expect(pq.severity).toBe("caution");
    expect(pq.reason).toContain("Insufficient");
  });

  it("only sub-8-trade pairs → caution (under MIN_PAIR_TRADES_FOR_PRUNE)", async () => {
    mockedGetAllPairStats.mockResolvedValue(
      new Map([
        ["XAU/USD", { ticker: "XAU/USD", trades: 5, wins: 1, win_rate: 0.2, net_pnl: -100 }],
      ])
    );
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const pq = findCheck(r.report.checks, "pair_quality");
    // 20% WR is BELOW the 30% floor, but trades count (5) is BELOW the
    // 8-trade pruning threshold → not flagged as a loser yet (insufficient sample)
    expect(pq.severity).toBe("caution");
  });

  it("all pairs above 30% WR floor → pass", async () => {
    mockedGetAllPairStats.mockResolvedValue(
      new Map([
        ["XAU/USD", { ticker: "XAU/USD", trades: 20, wins: 12, win_rate: 0.6, net_pnl: 1500 }],
        ["EUR/USD", { ticker: "EUR/USD", trades: 15, wins: 6, win_rate: 0.4, net_pnl: 500 }],
      ])
    );
    const supabase = makeSupabaseReadinessMock({ algoData: makeAlgo() });
    const r = await runReadinessCheck(supabase, "algo-1");
    if (!r.ok) throw new Error("expected ok");
    const pq = findCheck(r.report.checks, "pair_quality");
    expect(pq.severity).toBe("pass");
    expect(pq.reason).toContain("All 2 pairs above");
  });
});

// ======================================================================
// Side symmetry branches
// ======================================================================

describe("runReadinessCheck — side symmetry branches", () => {
  function sideCheck(r: { ok: boolean; report?: { checks: { name: string; severity: string; reason: string }[] } }) {
    if (!r.ok || !r.report) throw new Error("expected ok");
    const c = r.report.checks.find((x) => x.name === "side_symmetry");
    if (!c) throw new Error("side_symmetry check missing");
    return c;
  }

  it("side='auto' → caution (CHF/JPY short trap reference)", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({ rules: makeRules({ side: "auto" }) }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = sideCheck(r);
    expect(c.severity).toBe("caution");
    expect(c.reason).toContain("CHF/JPY short trap");
  });

  it("side='long' → pass", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({ rules: makeRules({ side: "long" }) }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = sideCheck(r);
    expect(c.severity).toBe("pass");
    expect(c.reason).toContain("side='long'");
  });

  it("side undefined → pass with implicit 'long' fallback in label", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({ side: undefined as unknown as AlgorithmRules["side"] }),
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = sideCheck(r);
    expect(c.severity).toBe("pass");
    expect(c.reason).toContain("side='long'"); // label fallback
  });
});

// ======================================================================
// FTMO fit branches
// ======================================================================

describe("runReadinessCheck — FTMO fit branches", () => {
  function ftmoCheck(r: { ok: boolean; report?: { checks: { name: string; severity: string; reason: string }[] } }) {
    if (!r.ok || !r.report) throw new Error("expected ok");
    const c = r.report.checks.find((x) => x.name === "ftmo_fit");
    if (!c) throw new Error("ftmo_fit check missing");
    return c;
  }

  it("risk_per_trade > 1% → caution mentioning DD risk", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({
          position_sizing: { type: "risk_per_trade", value: 2 },
        } as unknown as Partial<AlgorithmRules>),
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = ftmoCheck(r);
    expect(c.severity).toBe("caution");
    expect(c.reason).toContain("risk_per_trade 2%");
  });

  it("no consecutive_loss_daily_halt → caution mentioning DLL chain risk", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({ prop_firm: { consecutive_loss_daily_halt: 0 } } as unknown as Partial<AlgorithmRules>),
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = ftmoCheck(r);
    expect(c.severity).toBe("caution");
    expect(c.reason).toContain("no consecutive_loss_daily_halt");
  });

  it("BOTH issues → caution joined with '; '", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({
          position_sizing: { type: "risk_per_trade", value: 2 },
          prop_firm: { consecutive_loss_daily_halt: 0 },
        } as unknown as Partial<AlgorithmRules>),
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = ftmoCheck(r);
    expect(c.severity).toBe("caution");
    expect(c.reason).toContain("risk_per_trade");
    expect(c.reason).toContain("no consecutive_loss_daily_halt");
    expect(c.reason).toContain("; ");
  });

  it("clean → pass with sizing + halt summary", async () => {
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({
        rules: makeRules({
          position_sizing: { type: "risk_per_trade", value: 1 },
          prop_firm: { consecutive_loss_daily_halt: 3 },
        } as unknown as Partial<AlgorithmRules>),
      }),
    });
    const r = await runReadinessCheck(supabase, "algo-1");
    const c = ftmoCheck(r);
    expect(c.severity).toBe("pass");
    expect(c.reason).toContain("risk_per_trade=1");
    expect(c.reason).toContain("consecutive_loss_daily_halt 3");
  });
});

// ======================================================================
// Output shape + watchlist uppercase
// ======================================================================

describe("runReadinessCheck — output shape", () => {
  it("report carries algorithm_id, algorithm_name, verdict, 4 checks, walk_forward_summary (5 stats)", async () => {
    mockedRunWalkForward.mockReturnValue({
      total_windows: 5,
      mean_win_rate: 0.55,
      mean_return: 6_000,
      mean_drawdown: 4,
      win_rate_of_windows: 0.8,
      windows: Array.from({ length: 5 }, () => ({ total_return: 6_000, max_drawdown: 4 })),
    });
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo({ name: "Gold FVG-DailyBias-Long 4h" }),
    });
    const r = await runReadinessCheck(supabase, "algo-XYZ");
    if (!r.ok) throw new Error("expected ok");
    expect(r.report).toMatchObject({
      algorithm_id: "algo-XYZ",
      algorithm_name: "Gold FVG-DailyBias-Long 4h",
      verdict: expect.stringMatching(/^(pass|caution|fail)$/),
      checks: expect.any(Array),
      walk_forward_summary: {
        windows: 5,
        mean_win_rate: 0.55,
        mean_return: 6_000,
        mean_drawdown: 4,
        win_rate_of_windows: 0.8,
      },
    });
    expect(r.report.checks).toHaveLength(4);
    // The 4 checks always present (regardless of severity)
    expect(r.report.checks.map((c) => c.name).sort()).toEqual([
      "ftmo_fit",
      "pair_quality",
      "side_symmetry",
      "walk_forward_stability",
    ]);
  });

  it("watchlist tickers UPPERCASED before being passed to runWalkForward", async () => {
    let capturedPricesByTicker: Map<string, unknown> | null = null;
    mockedRunWalkForward.mockImplementation((_rules, prices) => {
      capturedPricesByTicker = prices as Map<string, unknown>;
      return cleanWf();
    });
    // getCachedPrices returns prices for the uppercased key
    mockedGetCachedPrices.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        open: 3000,
        high: 3010,
        low: 2990,
        close: 3005,
        volume: 100,
      }))
    );
    const supabase = makeSupabaseReadinessMock({
      algoData: makeAlgo(),
      tickers: [{ ticker: "xau/usd" }, { ticker: "EuR/UsD" }],
    });
    await runReadinessCheck(supabase, "algo-1");
    expect(capturedPricesByTicker).not.toBeNull();
    expect(Array.from(capturedPricesByTicker?.keys() ?? [])).toEqual(["XAU/USD", "EUR/USD"]);
  });
});
