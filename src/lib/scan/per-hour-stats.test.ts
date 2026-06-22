/**
 * CB.T1 Tier 3 — per-hour-stats.ts (2026-06-23).
 *
 * Pure aggregator over closed paper_positions. Tests:
 *   - 24 buckets always returned (hours 0-23)
 *   - Trades bucketed by opened_at UTC hour
 *   - wr_pct = wins / samples × 100
 *   - informative flag respects min_samples (default 5)
 *   - null realized_pnl skipped
 *   - zero pnl (BE) NOT counted as win OR loss (so samples unaffected)
 *   - window_days adds .gte filter; omitted = all trades
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPerHourStats } from "./per-hour-stats";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeSupabase(opts: {
  rows?: Array<{ realized_pnl: number | null; opened_at: string }>;
  gteCapture?: { col?: string; val?: unknown };
}) {
  const builder: Record<string, unknown> = {};
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
    if (opts.gteCapture) {
      opts.gteCapture.col = col;
      opts.gteCapture.val = val;
    }
    return builder;
  });
  builder.then = (onful?: (v: unknown) => unknown, onrej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: opts.rows ?? [], error: null }).then(onful, onrej);
  const fromMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue(builder),
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, builder };
}

beforeEach(() => vi.clearAllMocks());

describe("getPerHourStats", () => {
  it("returns 24 buckets always (hours 0-23 present even with zero trades)", async () => {
    const { supabase } = makeSupabase({ rows: [] });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.size).toBe(24);
    for (let h = 0; h < 24; h++) {
      expect(m.get(h)).toMatchObject({ hour: h, samples: 0, informative: false });
    }
  });

  it("trades bucketed by opened_at UTC hour", async () => {
    const { supabase } = makeSupabase({
      rows: [
        { realized_pnl: 100, opened_at: "2026-06-22T07:30:00Z" }, // hour 7
        { realized_pnl: -50, opened_at: "2026-06-22T07:45:00Z" }, // hour 7
        { realized_pnl: 200, opened_at: "2026-06-22T14:00:00Z" }, // hour 14
      ],
    });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.get(7)!.samples).toBe(2);
    expect(m.get(7)!.wins).toBe(1);
    expect(m.get(7)!.losses).toBe(1);
    expect(m.get(14)!.samples).toBe(1);
    expect(m.get(14)!.wins).toBe(1);
  });

  it("wr_pct = (wins / samples) × 100", async () => {
    const { supabase } = makeSupabase({
      rows: [
        { realized_pnl: 100, opened_at: "2026-06-22T10:00:00Z" },
        { realized_pnl: 100, opened_at: "2026-06-22T10:00:00Z" },
        { realized_pnl: 100, opened_at: "2026-06-22T10:00:00Z" },
        { realized_pnl: -50, opened_at: "2026-06-22T10:00:00Z" },
      ],
    });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.get(10)!.wr_pct).toBe(75);
  });

  it("informative flag respects min_samples (default 5)", async () => {
    const rows = Array.from({ length: 4 }, () => ({
      realized_pnl: 100,
      opened_at: "2026-06-22T08:00:00Z",
    }));
    const { supabase } = makeSupabase({ rows });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.get(8)!.samples).toBe(4);
    expect(m.get(8)!.informative).toBe(false); // 4 < 5
  });

  it("informative flag honors custom min_samples", async () => {
    const rows = Array.from({ length: 3 }, () => ({
      realized_pnl: 100,
      opened_at: "2026-06-22T08:00:00Z",
    }));
    const { supabase } = makeSupabase({ rows });
    const m = await getPerHourStats(supabase, "algo-1", { min_samples: 2 });
    expect(m.get(8)!.informative).toBe(true); // 3 >= 2
  });

  it("null realized_pnl skipped (open positions, no impact on bucket)", async () => {
    const { supabase } = makeSupabase({
      rows: [
        { realized_pnl: null, opened_at: "2026-06-22T08:00:00Z" },
        { realized_pnl: 100, opened_at: "2026-06-22T08:00:00Z" },
      ],
    });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.get(8)!.samples).toBe(1);
  });

  it("zero pnl (BE) NOT counted as win OR loss", async () => {
    const { supabase } = makeSupabase({
      rows: [
        { realized_pnl: 0, opened_at: "2026-06-22T08:00:00Z" },
        { realized_pnl: 0, opened_at: "2026-06-22T08:00:00Z" },
      ],
    });
    const m = await getPerHourStats(supabase, "algo-1");
    expect(m.get(8)!.samples).toBe(0);
    expect(m.get(8)!.wins).toBe(0);
    expect(m.get(8)!.losses).toBe(0);
  });

  it("window_days adds .gte('opened_at', cutoff)", async () => {
    const gteCapture: { col?: string; val?: unknown } = {};
    const { supabase } = makeSupabase({ rows: [], gteCapture });
    await getPerHourStats(supabase, "algo-1", { window_days: 30 });
    expect(gteCapture.col).toBe("opened_at");
    expect(typeof gteCapture.val).toBe("string");
  });

  it("window_days omitted → no .gte filter applied", async () => {
    const gteCapture: { col?: string; val?: unknown } = {};
    const { supabase } = makeSupabase({ rows: [], gteCapture });
    await getPerHourStats(supabase, "algo-1");
    expect(gteCapture.col).toBeUndefined();
  });
});
