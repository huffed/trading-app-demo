/**
 * Unit tests for the re-entry cooldown gate (CB.T1.3 pass 1, 2026-06-22).
 * Tests `checkReEntryCooldown` — the race-fix introduced after the 2026-
 * 05-12 30m gold incident where a -$98 stop-out was followed 19 seconds
 * later by an `enter_long` on the same algo+ticker that opened at 3.2×
 * the lost trade's size and lost -$399 before the consec-loss halt could
 * see the first loss. This gate refuses re-entries on the same algo+
 * ticker within N minutes of any LOSS exit. Wins don't trigger cooldown.
 *
 * Coverage (~18 tests):
 *
 *  No-history paths (2):
 *   - maybeSingle returns null → no_recent_close, block:false
 *   - row exists but closed_at is null → no_recent_close, block:false
 *
 *  Win-exit path (3):
 *   - Positive realized_pnl + exit_reason=take_profit → last_was_win
 *   - Positive realized_pnl + exit_reason=null → last_was_win
 *   - realized_pnl = 0 (BE) + exit_reason=manual_close → last_was_win
 *
 *  Loss-exit blocking (4):
 *   - exit_reason=stop_loss → block:true, in_cooldown
 *   - exit_reason=stagnant_exit → block:true (the original 2026-05-12 vector)
 *   - Negative realized_pnl + exit_reason=exit_signal → block:true (inferred)
 *   - Negative realized_pnl + exit_reason=null → block:true (inferred)
 *
 *  Cooldown window boundary (3):
 *   - elapsed < cooldown → block:true (in_cooldown)
 *   - elapsed === cooldown → block:false (uses '<', boundary exclusive)
 *   - elapsed > cooldown → block:false (cooldown_elapsed)
 *
 *  Timeframe → default cooldown mapping (5):
 *   - 15m → 15 min default
 *   - 30m → 30 min default
 *   - 1h → 60 min default
 *   - 4h → 240 min default
 *   - 1day → 1440 min default
 *
 *  Override + payload + query (3):
 *   - cooldownMinutes override takes precedence over timeframe default
 *   - Reason string includes elapsed_min + exit_reason + realized_pnl + cooldown_min
 *   - Query construction: paper_positions filters (algorithm_id, ticker,
 *     status=closed) + order(closed_at desc) + limit(1) + maybeSingle
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkReEntryCooldown } from "./re-entry-cooldown";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Supabase chain mock. ---------------------------------------------
// Chain:
//   .from("paper_positions")
//   .select("id, exit_reason, realized_pnl, closed_at")
//   .eq("algorithm_id", id).eq("ticker", t).eq("status", "closed")
//   .order("closed_at", { ascending: false })
//   .limit(1)
//   .maybeSingle()  ← awaits Promise<{data: row|null, error: null}>
type ClosedRowShape = {
  id: string;
  exit_reason: string | null;
  realized_pnl: number | null;
  closed_at: string | null;
};

interface SupabaseMockBag {
  supabase: SupabaseClient;
  fromMock: ReturnType<typeof vi.fn>;
  capturedSelect: string | null;
  capturedEqCalls: Array<[string, unknown]>;
  capturedOrder: [string, { ascending: boolean }] | null;
  capturedLimit: number | null;
}

function makeSupabaseReentryMock(opts: {
  data?: ClosedRowShape | null;
  error?: { message: string } | null;
} = {}): SupabaseMockBag {
  const capturedEqCalls: Array<[string, unknown]> = [];
  let capturedSelect: string | null = null;
  let capturedOrder: [string, { ascending: boolean }] | null = null;
  let capturedLimit: number | null = null;

  const result = {
    data: opts.data === undefined ? null : opts.data,
    error: opts.error ?? null,
  };

  const maybeSingleMock = vi.fn().mockResolvedValue(result);
  const limitMock = vi.fn().mockImplementation((n: number) => {
    capturedLimit = n;
    return { maybeSingle: maybeSingleMock };
  });
  const orderMock = vi.fn().mockImplementation((col: string, params: { ascending: boolean }) => {
    capturedOrder = [col, params];
    return { limit: limitMock };
  });
  const builder = {
    eq: vi.fn().mockImplementation((col: string, val: unknown) => {
      capturedEqCalls.push([col, val]);
      return builder;
    }),
    order: orderMock,
  };
  const selectMock = vi.fn().mockImplementation((cols: string) => {
    capturedSelect = cols;
    return builder;
  });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });
  const supabaseStub = Object.create(null) as Record<string, unknown>;
  supabaseStub.from = fromMock;
  return {
    supabase: supabaseStub as unknown as SupabaseClient,
    fromMock,
    get capturedSelect() {
      return capturedSelect;
    },
    capturedEqCalls,
    get capturedOrder() {
      return capturedOrder;
    },
    get capturedLimit() {
      return capturedLimit;
    },
  };
}

// ---- Fixture helpers. -------------------------------------------------
const NOW = new Date("2026-06-22T12:00:00.000Z");

function closedRow(overrides: Partial<ClosedRowShape> = {}): ClosedRowShape {
  return {
    id: "pos-1",
    exit_reason: "stop_loss",
    realized_pnl: -100,
    closed_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), // 5 min ago
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ======================================================================
// No-history paths — gate never fires
// ======================================================================

describe("checkReEntryCooldown — no recent close history", () => {
  it("maybeSingle returns null → no_recent_close, block:false", async () => {
    const { supabase } = makeSupabaseReentryMock({ data: null });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r).toEqual({
      block: false,
      status: "no_recent_close",
      cooldown_minutes: 30,
    });
  });

  it("row exists but closed_at is null → no_recent_close, block:false", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ closed_at: null }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("no_recent_close");
  });
});

// ======================================================================
// Last close was a win — gate never fires
// ======================================================================

describe("checkReEntryCooldown — last close was a win (no block)", () => {
  it("positive realized_pnl + exit_reason=take_profit → last_was_win, block:false", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "take_profit", realized_pnl: 200 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("last_was_win");
    expect(r.last_exit_reason).toBe("take_profit");
    expect(r.last_realized_pnl).toBe(200);
  });

  it("positive realized_pnl + exit_reason=null → last_was_win (pnl-only check)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: null, realized_pnl: 50 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("last_was_win");
  });

  it("BE (realized_pnl=0) + non-loss exit_reason → last_was_win (not a loss)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "manual_close", realized_pnl: 0 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("last_was_win");
  });
});

// ======================================================================
// Loss-exit triggers cooldown (4 trigger conditions)
// ======================================================================

describe("checkReEntryCooldown — loss exits trigger cooldown", () => {
  it("exit_reason=stop_loss within window → block:true, in_cooldown", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "stop_loss", realized_pnl: -100 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
    expect(r.last_exit_reason).toBe("stop_loss");
    expect(r.last_realized_pnl).toBe(-100);
  });

  it("exit_reason=stagnant_exit within window → block:true (the 2026-05-12 vector)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "stagnant_exit", realized_pnl: -25 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
    expect(r.last_exit_reason).toBe("stagnant_exit");
  });

  it("negative realized_pnl + exit_reason=exit_signal → block:true (inferred loss)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "exit_signal", realized_pnl: -50 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
  });

  it("negative realized_pnl + exit_reason=null → block:true (inferred from pnl)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: null, realized_pnl: -10 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
  });
});

// ======================================================================
// Cooldown-window boundary
// ======================================================================

describe("checkReEntryCooldown — cooldown window boundary", () => {
  it("elapsed < cooldown → block:true (in_cooldown)", async () => {
    const closedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString(); // 10 min ago
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ closed_at: closedAt, exit_reason: "stop_loss", realized_pnl: -50 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m", // 30-min cooldown
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
    expect(r.elapsed_minutes).toBe(10);
    expect(r.cooldown_minutes).toBe(30);
  });

  it("elapsed === cooldown → block:false (uses '<' — boundary exclusive)", async () => {
    const closedAt = new Date(NOW.getTime() - 30 * 60_000).toISOString(); // exactly 30 min ago
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ closed_at: closedAt, exit_reason: "stop_loss", realized_pnl: -50 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("cooldown_elapsed");
    expect(r.elapsed_minutes).toBe(30);
  });

  it("elapsed > cooldown → block:false (cooldown_elapsed)", async () => {
    const closedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // 60 min ago
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ closed_at: closedAt, exit_reason: "stop_loss", realized_pnl: -50 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.status).toBe("cooldown_elapsed");
    expect(r.elapsed_minutes).toBe(60);
  });
});

// ======================================================================
// Timeframe → default cooldown mapping
// ======================================================================

describe("checkReEntryCooldown — timeframe default cooldown mapping", () => {
  const cases: Array<[string, number]> = [
    ["15m", 15],
    ["30m", 30],
    ["1h", 60],
    ["4h", 240],
    ["1day", 1440],
  ];

  for (const [tf, expectedMin] of cases) {
    it(`timeframe='${tf}' → default cooldown_minutes=${expectedMin}`, async () => {
      const { supabase } = makeSupabaseReentryMock({ data: null });
      const r = await checkReEntryCooldown({
        supabase,
        algorithmId: "algo-1",
        ticker: "XAU/USD",
        timeframe: tf,
        now: NOW,
      });
      expect(r.cooldown_minutes).toBe(expectedMin);
    });
  }
});

// ======================================================================
// Override + payload + query construction
// ======================================================================

describe("checkReEntryCooldown — override, payload, query construction", () => {
  it("cooldownMinutes override takes precedence over timeframe default", async () => {
    const { supabase } = makeSupabaseReentryMock({ data: null });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m", // default would be 30
      cooldownMinutes: 120, // override
      now: NOW,
    });
    expect(r.cooldown_minutes).toBe(120);
  });

  it("reason string on block includes elapsed + exit_reason + pnl + cooldown", async () => {
    const closedAt = new Date(NOW.getTime() - 7 * 60_000).toISOString(); // 7 min ago
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ closed_at: closedAt, exit_reason: "stop_loss", realized_pnl: -98.5 }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain("Re-entry cooldown");
    expect(r.reason).toContain("7.0 min");
    expect(r.reason).toContain("stop_loss");
    expect(r.reason).toContain("$-98.50");
    expect(r.reason).toContain("30 min cooldown");
  });

  it("queries paper_positions with correct filters + ordering + limit(1) + maybeSingle", async () => {
    const conf = makeSupabaseReentryMock({ data: null });
    await checkReEntryCooldown({
      supabase: conf.supabase,
      algorithmId: "algo-XYZ",
      ticker: "EUR/USD",
      timeframe: "4h",
      now: NOW,
    });
    expect(conf.fromMock).toHaveBeenCalledWith("paper_positions");
    expect(conf.capturedSelect).toContain("id");
    expect(conf.capturedSelect).toContain("exit_reason");
    expect(conf.capturedSelect).toContain("realized_pnl");
    expect(conf.capturedSelect).toContain("closed_at");
    expect(conf.capturedEqCalls).toEqual([
      ["algorithm_id", "algo-XYZ"],
      ["ticker", "EUR/USD"],
      ["status", "closed"],
    ]);
    expect(conf.capturedOrder).toEqual(["closed_at", { ascending: false }]);
    expect(conf.capturedLimit).toBe(1);
  });

  it("last_close_id is threaded into the result on both block and no-block paths", async () => {
    // Block path
    const { supabase: sup1 } = makeSupabaseReentryMock({
      data: closedRow({ id: "pos-blocked", exit_reason: "stop_loss", realized_pnl: -10 }),
    });
    const r1 = await checkReEntryCooldown({
      supabase: sup1,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r1.last_close_id).toBe("pos-blocked");

    // No-block win path
    const { supabase: sup2 } = makeSupabaseReentryMock({
      data: closedRow({ id: "pos-win", exit_reason: "take_profit", realized_pnl: 50 }),
    });
    const r2 = await checkReEntryCooldown({
      supabase: sup2,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r2.last_close_id).toBe("pos-win");
  });
});

// ======================================================================
// Numeric coercion of realized_pnl (DB returns numeric → string sometimes)
// ======================================================================

describe("checkReEntryCooldown — numeric coercion", () => {
  it("realized_pnl null → not a loss-by-pnl path (still respects exit_reason)", async () => {
    // null pnl with non-loss exit_reason → no block
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "take_profit", realized_pnl: null }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(false);
    expect(r.last_realized_pnl).toBeNull();
  });

  it("realized_pnl null + exit_reason=stop_loss → STILL blocks (exit_reason wins)", async () => {
    const { supabase } = makeSupabaseReentryMock({
      data: closedRow({ exit_reason: "stop_loss", realized_pnl: null }),
    });
    const r = await checkReEntryCooldown({
      supabase,
      algorithmId: "algo-1",
      ticker: "XAU/USD",
      timeframe: "30m",
      now: NOW,
    });
    expect(r.block).toBe(true);
    expect(r.status).toBe("in_cooldown");
  });
});
