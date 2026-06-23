/**
 * H.1 positioning-contrarian tests. Locks: fail-safe defaults (no
 * snapshot / stale / invalid → gate fails closed), contrarian semantic
 * (long when crowd short / vice versa), DB helper graceful handling of
 * missing rows + errors, evaluatePositioningGate AND-aggregation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_SNAPSHOT_AGE_MINUTES,
  evaluatePositioningContrarian,
  evaluatePositioningGate,
  fetchLatestPositioningSnapshot,
  type PositioningSnapshot,
} from "./positioning-contrarian";
import type { PositioningCondition } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

const T0 = new Date("2026-06-23T18:00:00Z");

function snap(opts: { ageMinutes?: number; long_pct?: number; short_pct?: number; instrument?: string } = {}): PositioningSnapshot {
  return {
    instrument: opts.instrument ?? "XAU_USD",
    oanda_time: new Date(T0.getTime() - (opts.ageMinutes ?? 5) * 60_000).toISOString(),
    price: 2050,
    long_pct: opts.long_pct ?? 50,
    short_pct: opts.short_pct ?? 50,
  };
}

function cond(opts: Partial<PositioningCondition> = {}): PositioningCondition {
  return {
    type: "positioning_contrarian",
    instrument: opts.instrument ?? "XAU_USD",
    crowd_threshold_pct: opts.crowd_threshold_pct ?? 70,
    max_snapshot_age_minutes: opts.max_snapshot_age_minutes,
    side: opts.side ?? "long",
    timeframe: opts.timeframe ?? "4h",
  };
}

// ─── pure evaluator ──────────────────────────────────────────────────

describe("evaluatePositioningContrarian (pure)", () => {
  it("LONG: fires when crowd heavily short (long_pct ≤ 100 − threshold)", () => {
    // threshold=70 → fire when long_pct ≤ 30. Test long_pct=25 → fires.
    const r = evaluatePositioningContrarian(cond({ side: "long", crowd_threshold_pct: 70 }), snap({ long_pct: 25, short_pct: 75 }), T0);
    expect(r.passes).toBe(true);
    expect(r.reason).toMatch(/Contrarian long signal/);
  });

  it("LONG: does NOT fire when crowd not heavily short", () => {
    const r = evaluatePositioningContrarian(cond({ side: "long", crowd_threshold_pct: 70 }), snap({ long_pct: 50, short_pct: 50 }), T0);
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/No contrarian signal/);
  });

  it("LONG: edge — long_pct exactly at boundary (100 − threshold) PASSES (≤)", () => {
    const r = evaluatePositioningContrarian(cond({ side: "long", crowd_threshold_pct: 70 }), snap({ long_pct: 30 }), T0);
    expect(r.passes).toBe(true);
  });

  it("SHORT: fires when crowd heavily long (long_pct ≥ threshold)", () => {
    // threshold=70 → fire when long_pct ≥ 70. Test long_pct=80 → fires.
    const r = evaluatePositioningContrarian(cond({ side: "short", crowd_threshold_pct: 70 }), snap({ long_pct: 80, short_pct: 20 }), T0);
    expect(r.passes).toBe(true);
    expect(r.reason).toMatch(/Contrarian short signal/);
  });

  it("SHORT: does NOT fire when crowd not heavily long", () => {
    const r = evaluatePositioningContrarian(cond({ side: "short", crowd_threshold_pct: 70 }), snap({ long_pct: 50 }), T0);
    expect(r.passes).toBe(false);
  });

  it("SHORT: edge — long_pct exactly at boundary (threshold) PASSES (≥)", () => {
    const r = evaluatePositioningContrarian(cond({ side: "short", crowd_threshold_pct: 70 }), snap({ long_pct: 70 }), T0);
    expect(r.passes).toBe(true);
  });

  it("fail-safe: no snapshot → passes=false + reason includes 'No positioning snapshot'", () => {
    const r = evaluatePositioningContrarian(cond(), null, T0);
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/No positioning snapshot/);
    expect(r.snapshot).toBeNull();
    expect(r.snapshot_age_minutes).toBeNull();
  });

  it("fail-safe: stale snapshot (older than max_age) → passes=false + 'Snapshot stale'", () => {
    // Snapshot 35 min old vs default max 30
    const r = evaluatePositioningContrarian(cond({ side: "long", crowd_threshold_pct: 70 }), snap({ ageMinutes: 35, long_pct: 25 }), T0);
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/Snapshot stale/);
    expect(r.snapshot_age_minutes).toBeCloseTo(35, 0);
  });

  it("fail-safe: snapshot at exactly max_age PASSES (≤ boundary)", () => {
    const r = evaluatePositioningContrarian(
      cond({ side: "long", crowd_threshold_pct: 70, max_snapshot_age_minutes: 30 }),
      snap({ ageMinutes: 30, long_pct: 25 }),
      T0,
    );
    expect(r.passes).toBe(true);
  });

  it("honors max_snapshot_age_minutes override", () => {
    const condShortAge = cond({ side: "long", crowd_threshold_pct: 70, max_snapshot_age_minutes: 10 });
    const r = evaluatePositioningContrarian(condShortAge, snap({ ageMinutes: 15, long_pct: 25 }), T0);
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/Snapshot stale/);
  });

  it("DEFAULT_MAX_SNAPSHOT_AGE_MINUTES is 30 (matches OANDA cron's 20min cadence + jitter)", () => {
    expect(DEFAULT_MAX_SNAPSHOT_AGE_MINUTES).toBe(30);
  });

  it("fail-safe: invalid long_pct (NaN / negative / >100) → passes=false", () => {
    expect(evaluatePositioningContrarian(cond(), { ...snap(), long_pct: NaN }, T0).passes).toBe(false);
    expect(evaluatePositioningContrarian(cond(), { ...snap(), long_pct: -10 }, T0).passes).toBe(false);
    expect(evaluatePositioningContrarian(cond(), { ...snap(), long_pct: 150 }, T0).passes).toBe(false);
  });
});

// ─── DB helper ───────────────────────────────────────────────────────

function fakeSupabase(opts: { row?: Record<string, unknown> | null; error?: { message: string } }) {
  return {
    from: (table: string) => {
      if (table !== "oanda_positioning_cache") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: opts.row ?? null, error: opts.error ?? null }),
              }),
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("fetchLatestPositioningSnapshot", () => {
  it("returns the snapshot when query succeeds with a row", async () => {
    const client = fakeSupabase({
      row: {
        instrument: "XAU_USD",
        oanda_time: "2026-06-23T17:55:00Z",
        price: "2050.5",
        long_pct: "25.3",
        short_pct: "74.7",
      },
    });
    const r = await fetchLatestPositioningSnapshot(client, "XAU_USD");
    expect(r).toEqual({
      instrument: "XAU_USD",
      oanda_time: "2026-06-23T17:55:00Z",
      price: 2050.5,
      long_pct: 25.3,
      short_pct: 74.7,
    });
  });

  it("returns null when no rows exist (legitimate empty state)", async () => {
    const client = fakeSupabase({ row: null });
    const r = await fetchLatestPositioningSnapshot(client, "XAU_USD");
    expect(r).toBeNull();
  });

  it("returns null + logs when query errors (graceful)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeSupabase({ row: null, error: { message: "transient db blip" } });
    const r = await fetchLatestPositioningSnapshot(client, "XAU_USD");
    expect(r).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── evaluatePositioningGate (multi-condition orchestration) ──────────

describe("evaluatePositioningGate (live entry-gate wrapper)", () => {
  function multiCondSupabase(snapsByInstrument: Record<string, PositioningSnapshot | null>) {
    return {
      from: (table: string) => {
        if (table !== "oanda_positioning_cache") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_col: string, instrument: string) => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => {
                    const s = snapsByInstrument[instrument];
                    return Promise.resolve({ data: s ?? null, error: null });
                  },
                }),
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;
  }

  it("0 conditions → passes:true with 'No positioning conditions' reason", async () => {
    const r = await evaluatePositioningGate(multiCondSupabase({}), [], T0);
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("No positioning conditions");
    expect(r.evaluated_conditions).toBe(0);
  });

  it("1 condition passing → returns passes:true with last snapshot info", async () => {
    const client = multiCondSupabase({ XAU_USD: snap({ long_pct: 25 }) });
    const r = await evaluatePositioningGate(client, [cond({ side: "long", crowd_threshold_pct: 70 })], T0);
    expect(r.passes).toBe(true);
    expect(r.evaluated_conditions).toBe(1);
    expect(r.snapshot?.instrument).toBe("XAU_USD");
  });

  it("multiple conditions — fails fast on first non-passing (AND semantic)", async () => {
    const client = multiCondSupabase({
      XAU_USD: snap({ instrument: "XAU_USD", long_pct: 25 }), // passes for LONG threshold=70
      EUR_USD: snap({ instrument: "EUR_USD", long_pct: 50 }), // does NOT pass for LONG threshold=70
    });
    const conds = [
      cond({ instrument: "XAU_USD", side: "long", crowd_threshold_pct: 70 }),
      cond({ instrument: "EUR_USD", side: "long", crowd_threshold_pct: 70 }),
    ];
    const r = await evaluatePositioningGate(client, conds, T0);
    expect(r.passes).toBe(false);
    expect(r.snapshot?.instrument).toBe("EUR_USD");
  });

  it("caches per-instrument snapshot fetches (no duplicate DB hit)", async () => {
    let fetchCount = 0;
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => {
                  fetchCount++;
                  return Promise.resolve({ data: snap({ long_pct: 25 }), error: null });
                },
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    // Two conditions on the SAME instrument — should hit the DB only once
    await evaluatePositioningGate(client, [
      cond({ instrument: "XAU_USD", side: "long", crowd_threshold_pct: 70 }),
      cond({ instrument: "XAU_USD", side: "long", crowd_threshold_pct: 60 }),
    ], T0);
    expect(fetchCount).toBe(1);
  });

  it("fails fail-safe when snapshot is missing for an instrument", async () => {
    const client = multiCondSupabase({});
    const r = await evaluatePositioningGate(client, [cond({ instrument: "XAU_USD", side: "long" })], T0);
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/No positioning snapshot/);
  });
});
