/**
 * Characterisation — where "today" starts for the daily-loss halt.
 *
 * Every day boundary in the code is UTC midnight (docs/CODE_QUALITY.md §3.4);
 * FTMO measures the daily loss from 00:00 Prague time (CE(S)T). Whether to
 * change that is an open operator decision (docs/DEBT.md D-14); until then
 * these tests pin the UTC behaviour and keep the gap visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDailyLossHalt } from "@/lib/scan/daily-halt";
import { getTodayAnchor } from "@/lib/utils/date";
import { asFixture } from "@/test-utils/fixture";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Minimal thenable query builder that records the filters it was given. */
function recordingClient(rowsByTable: Record<string, unknown[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lte", "order", "limit", "in"]) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) => {
      resolve({ data: rowsByTable[table] ?? [], error: null });
    };
    return b;
  };
  const client = asFixture<SupabaseClient>({ from: (table: string) => builder(table) });
  return { client, calls };
}

describe("getTodayAnchor — the code's definition of today", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is UTC midnight of the current UTC date", () => {
    vi.setSystemTime(new Date("2026-10-28T23:30:00.000Z"));
    expect(getTodayAnchor()).toEqual({ utcIso: "2026-10-28T00:00:00.000Z", utcDate: "2026-10-28" });
  });

  it("at 22:30 UTC in summer the code is still on the 28th", () => {
    vi.setSystemTime(new Date("2026-10-28T22:30:00.000Z"));
    expect(getTodayAnchor().utcDate).toBe("2026-10-28");
  });

  it.fails(
    "FTMO's day has already rolled to the 29th at 22:30 UTC in summer (00:30 CEST) — DEBT D-14, decision pending",
    () => {
      vi.setSystemTime(new Date("2026-10-28T22:30:00.000Z"));
      expect(getTodayAnchor().utcDate).toBe("2026-10-29");
    }
  );
});

describe("checkDailyLossHalt — the daily window it queries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts closes since UTC midnight and all open positions, on fixed capital", async () => {
    vi.setSystemTime(new Date("2026-10-28T23:30:00.000Z"));
    const { client, calls } = recordingClient({
      paper_positions: [{ realized_pnl: -1000, unrealized_pnl: -500 }],
    });
    const check = await checkDailyLossHalt(client, "algo-1", 100_000, 5, 80);
    const gte = calls.find((c) => c.method === "gte");
    expect(gte?.args).toEqual(["closed_at", "2026-10-28T00:00:00.000Z"]);
    // closed rows contribute realized (-1000), open rows contribute unrealized (-500): -1.5 % of $100K
    expect(check.realized).toBe(-1000);
    expect(check.unrealized).toBe(-500);
    expect(check.todaysPnlPct).toBeCloseTo(-1.5, 10);
    expect(check.thresholdPct).toBe(-4); // 5 % DLL × 80 % halt
    expect(check.tripped).toBe(false);
  });
});
