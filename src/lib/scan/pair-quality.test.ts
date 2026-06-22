/**
 * CB.T1 Tier 3 — pair-quality.ts (2026-06-23).
 *
 * Auto-pause helper for underperforming (algo, ticker) pairs. Tests:
 *   - aggregateStats math: win_rate / net_pnl / avg_win / avg_loss / total
 *   - getPairStats: empty data → null
 *   - shouldPrune: prunes only when trades >= minTrades AND wr <= threshold
 *   - shouldPrune boundary: wr exactly threshold prunes (≤ comparison)
 *   - evaluateAndPrune: auto_paused pre-existing → skips re-evaluation
 *   - evaluateAndPrune: prune writes update + returns prune+reason
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateAndPrune,
  getPairStats,
  shouldPrune,
  type PairStats,
} from "./pair-quality";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeSupabaseForPairStats(rows: Array<{ ticker: string; realized_pnl: number | null }>) {
  const builder: Record<string, unknown> = {};
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.not = vi.fn().mockReturnValue(builder);
  builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onful, onrej);
  const fromMock = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(builder) });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return stub as unknown as SupabaseClient;
}

beforeEach(() => vi.clearAllMocks());

describe("getPairStats — aggregation math", () => {
  it("empty rows → null", async () => {
    const r = await getPairStats(makeSupabaseForPairStats([]), "algo-1", "XAU/USD");
    expect(r).toBeNull();
  });

  it("wins/losses/wr/net_pnl/avg_win/avg_loss computed correctly", async () => {
    const rows = [
      { ticker: "XAU/USD", realized_pnl: 100 },
      { ticker: "XAU/USD", realized_pnl: 200 },
      { ticker: "XAU/USD", realized_pnl: -50 },
      { ticker: "XAU/USD", realized_pnl: -100 },
    ];
    const r = await getPairStats(makeSupabaseForPairStats(rows), "algo-1", "XAU/USD");
    expect(r).toEqual({
      ticker: "XAU/USD",
      trades: 4,
      wins: 2,
      losses: 2,
      win_rate: 0.5,
      net_pnl: 150,
      avg_win: 150,
      avg_loss: -75,
    });
  });

  it("zero pnl rows NOT counted as wins or losses", async () => {
    const rows = [
      { ticker: "XAU/USD", realized_pnl: 0 },
      { ticker: "XAU/USD", realized_pnl: 100 },
    ];
    const r = await getPairStats(makeSupabaseForPairStats(rows), "algo-1", "XAU/USD");
    expect(r!.trades).toBe(1);
    expect(r!.wins).toBe(1);
  });
});

describe("shouldPrune — decision logic", () => {
  function pair(overrides: Partial<PairStats> = {}): PairStats {
    return {
      ticker: "TEST",
      trades: 10,
      wins: 2,
      losses: 8,
      win_rate: 0.2,
      net_pnl: -100,
      avg_win: 50,
      avg_loss: -25,
      ...overrides,
    };
  }

  it("null stats → no prune", () => {
    expect(shouldPrune(null)).toEqual({ prune: false, reason: null });
  });

  it("trades < minTrades → no prune (insufficient sample)", () => {
    expect(shouldPrune(pair({ trades: 5, wins: 1, win_rate: 0.2 }))).toEqual({
      prune: false,
      reason: null,
    });
  });

  it("trades ≥ minTrades AND wr ≤ threshold → prune with reason", () => {
    const r = shouldPrune(pair());
    expect(r.prune).toBe(true);
    expect(r.reason).toContain("2/10 WR (20%)");
  });

  it("boundary: wr === threshold (0.3 default) → prunes (≤ comparison)", () => {
    const r = shouldPrune(pair({ wins: 3, win_rate: 0.3 }));
    expect(r.prune).toBe(true);
  });

  it("wr above threshold → no prune", () => {
    expect(shouldPrune(pair({ wins: 4, win_rate: 0.4 })).prune).toBe(false);
  });

  it("custom config overrides defaults", () => {
    // wr=0.4 should prune under threshold=0.5
    expect(shouldPrune(pair({ wins: 4, win_rate: 0.4 }), { minTrades: 5, wrThreshold: 0.5 }).prune).toBe(true);
  });
});

describe("evaluateAndPrune", () => {
  function makeSupabase(opts: {
    watchlist?: Array<{ id: string; ticker: string; auto_paused: boolean }>;
    pairData?: Array<{ ticker: string; realized_pnl: number | null }>;
    metricsResetAt?: string | null;
  }) {
    const updates: Array<{ payload: unknown; eq: [string, unknown] }> = [];
    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === "algorithm_watchlist") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation(() =>
              Promise.resolve({ data: opts.watchlist ?? [], error: null })
            ),
          }),
          update: vi.fn().mockImplementation((payload: unknown) => ({
            eq: vi.fn().mockImplementation((col: string, val: unknown) => {
              updates.push({ payload, eq: [col, val] });
              return Promise.resolve({ data: null, error: null });
            }),
          })),
        };
      }
      if (table === "algorithms") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { metrics_reset_at: opts.metricsResetAt ?? null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "paper_positions") {
        const builder: Record<string, unknown> = {};
        builder.eq = vi.fn().mockReturnValue(builder);
        builder.not = vi.fn().mockReturnValue(builder);
        builder.gte = vi.fn().mockReturnValue(builder);
        builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: opts.pairData ?? [], error: null }).then(onful, onrej);
        return { select: vi.fn().mockReturnValue(builder) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const stub = Object.create(null) as Record<string, unknown>;
    stub.from = fromMock;
    return { supabase: stub as unknown as SupabaseClient, updates };
  }

  it("already auto_paused ticker → result.pruned=true reason='already_paused', NO write", async () => {
    const { supabase, updates } = makeSupabase({
      watchlist: [{ id: "w1", ticker: "GBP/JPY", auto_paused: true }],
      pairData: [],
    });
    const r = await evaluateAndPrune(supabase, "algo-1");
    expect(r[0]).toMatchObject({ ticker: "GBP/JPY", pruned: true, reason: "already_paused" });
    expect(updates).toHaveLength(0);
  });

  it("fresh ticker that fails threshold → prune writes update with auto_paused + reason", async () => {
    const { supabase, updates } = makeSupabase({
      watchlist: [{ id: "w1", ticker: "BAD/PAIR", auto_paused: false }],
      pairData: Array.from({ length: 10 }, (_, i) => ({
        ticker: "BAD/PAIR",
        realized_pnl: i < 2 ? 50 : -25, // 2 wins, 8 losses = 20% WR
      })),
    });
    const r = await evaluateAndPrune(supabase, "algo-1");
    expect(r[0]).toMatchObject({ ticker: "BAD/PAIR", pruned: true });
    expect(r[0].reason).toContain("WR");
    expect(updates).toHaveLength(1);
    expect((updates[0].payload as { auto_paused: boolean }).auto_paused).toBe(true);
  });

  it("empty watchlist → returns empty array, no queries beyond watchlist load", async () => {
    const { supabase } = makeSupabase({ watchlist: [] });
    const r = await evaluateAndPrune(supabase, "algo-1");
    expect(r).toEqual([]);
  });
});
