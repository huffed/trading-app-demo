/**
 * G.3-followup tests for the live vol-target context builder. Locks:
 * R-multiple extraction from paper_positions, broken-row skip,
 * legacy-stop fallback (initial_stop_loss_price ?? stop_loss_price),
 * DESC→ASC reversal so rolling math sees chronological order, ATR
 * fallback to 0 when bars insufficient, graceful empty/error returns.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildVolTargetLiveContext,
  LIVE_R_MULTIPLE_HISTORY_CAP,
} from "./vol-target-live-context";
import type { PriceBar } from "@/lib/market-data/types";
import type { SupabaseClient } from "@supabase/supabase-js";

function syntheticBars(n: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let close = 2000;
  for (let i = 0; i < n; i++) {
    const newClose = close + 0.5 + Math.sin(i * 0.7) * 5;
    bars.push({
      date: new Date(1577836800000 + i * 4 * 3_600_000).toISOString(),
      open: close,
      high: Math.max(close, newClose) + 2,
      low: Math.min(close, newClose) - 2,
      close: newClose,
      volume: 100,
    });
    close = newClose;
  }
  return bars;
}

interface FakePos {
  side: string;
  entry_price: number;
  exit_price: number | null;
  initial_stop_loss_price: number | null;
  stop_loss_price: number | null;
  realized_pnl: number | null;
  closed_at: string | null;
}

function fakeSupabase(opts: { rows?: FakePos[]; error?: { message: string } }): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "paper_positions") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: opts.rows ?? null, error: opts.error ?? null }),
              }),
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("buildVolTargetLiveContext", () => {
  const BARS = syntheticBars(50);

  it("computes instrumentVolPct = atr14 / currentPrice", async () => {
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows: [] }), "a1", BARS, 2000);
    expect(ctx.instrumentVolPct).toBeGreaterThan(0);
    expect(ctx.instrumentVolPct).toBeLessThan(1); // small fraction of price
  });

  it("returns 0 instrumentVolPct when bars insufficient for ATR(14)", async () => {
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows: [] }), "a1", BARS.slice(0, 10), 2000);
    expect(ctx.instrumentVolPct).toBe(0);
  });

  it("returns 0 instrumentVolPct when currentPrice ≤ 0 (defensive)", async () => {
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows: [] }), "a1", BARS, 0);
    expect(ctx.instrumentVolPct).toBe(0);
  });

  it("computes R-multiples per closed long position: +R when exit above entry, −R when below SL", async () => {
    // entry 2000, SL 1980 (risk=20), exit 2040 → R = +2.0
    // entry 2000, SL 1980 (risk=20), exit 1980 → R = −1.0
    const rows: FakePos[] = [
      { side: "long", entry_price: 2000, exit_price: 2040, initial_stop_loss_price: 1980, stop_loss_price: null, realized_pnl: 40, closed_at: "2026-06-02T00:00:00Z" },
      { side: "long", entry_price: 2000, exit_price: 1980, initial_stop_loss_price: 1980, stop_loss_price: null, realized_pnl: -20, closed_at: "2026-06-01T00:00:00Z" },
    ];
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows }), "a1", BARS, 2000);
    // DB returns DESC; helper reverses to ASC chronological. Earlier
    // close goes first → R=-1, then R=+2.
    expect(ctx.rMultipleHistory).toHaveLength(2);
    expect(ctx.rMultipleHistory[0]).toBeCloseTo(-1.0, 6);
    expect(ctx.rMultipleHistory[1]).toBeCloseTo(2.0, 6);
  });

  it("handles short positions correctly (R sign flipped)", async () => {
    // SHORT entry 2000, SL 2020 (risk=20), exit 1960 → R = +2.0
    const rows: FakePos[] = [
      { side: "short", entry_price: 2000, exit_price: 1960, initial_stop_loss_price: 2020, stop_loss_price: null, realized_pnl: 40, closed_at: "2026-06-01T00:00:00Z" },
    ];
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows }), "a1", BARS, 2000);
    expect(ctx.rMultipleHistory).toHaveLength(1);
    expect(ctx.rMultipleHistory[0]).toBeCloseTo(2.0, 6);
  });

  it("falls back to stop_loss_price when initial_stop_loss_price is null (pre-00032 legacy)", async () => {
    const rows: FakePos[] = [
      { side: "long", entry_price: 2000, exit_price: 2040, initial_stop_loss_price: null, stop_loss_price: 1980, realized_pnl: 40, closed_at: "2026-06-01T00:00:00Z" },
    ];
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows }), "a1", BARS, 2000);
    expect(ctx.rMultipleHistory).toHaveLength(1);
    expect(ctx.rMultipleHistory[0]).toBeCloseTo(2.0, 6);
  });

  it("skips broken-state rows (missing exit / missing stop / risk ≤ 0)", async () => {
    const rows: FakePos[] = [
      { side: "long", entry_price: 2000, exit_price: null, initial_stop_loss_price: 1980, stop_loss_price: null, realized_pnl: 0, closed_at: "2026-06-01T00:00:00Z" },        // no exit
      { side: "long", entry_price: 2000, exit_price: 2040, initial_stop_loss_price: null, stop_loss_price: null, realized_pnl: 40, closed_at: "2026-06-01T00:00:00Z" },      // no stop
      { side: "long", entry_price: 2000, exit_price: 2040, initial_stop_loss_price: 2010, stop_loss_price: null, realized_pnl: 40, closed_at: "2026-06-01T00:00:00Z" },      // SL above entry (risk ≤ 0)
      { side: "long", entry_price: 2000, exit_price: 2040, initial_stop_loss_price: 1980, stop_loss_price: null, realized_pnl: 40, closed_at: "2026-06-01T00:00:00Z" },      // valid
    ];
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows }), "a1", BARS, 2000);
    expect(ctx.rMultipleHistory).toHaveLength(1);
    expect(ctx.rMultipleHistory[0]).toBeCloseTo(2.0, 6);
  });

  it("returns empty rMultipleHistory when DB query errors (graceful, logs)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await buildVolTargetLiveContext(
      fakeSupabase({ rows: null as unknown as FakePos[], error: { message: "transient blip" } }),
      "a1",
      BARS,
      2000,
    );
    expect(ctx.rMultipleHistory).toEqual([]);
    expect(ctx.instrumentVolPct).toBeGreaterThan(0); // ATR still computed
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("returns empty rMultipleHistory when no rows exist (algo has no closed trades yet)", async () => {
    const ctx = await buildVolTargetLiveContext(fakeSupabase({ rows: [] }), "a1", BARS, 2000);
    expect(ctx.rMultipleHistory).toEqual([]);
  });

  it("LIVE_R_MULTIPLE_HISTORY_CAP is 200 (matches backtest R_MULTIPLE_HISTORY_CAP)", () => {
    expect(LIVE_R_MULTIPLE_HISTORY_CAP).toBe(200);
  });
});
