import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPriceCacheRowCopiesForTests,
  filterIncomingBars,
  getCachedPrices,
  MAX_BARS_PER_ROW,
  medianSpacingMinutes,
  normalizeBarDate,
  savePricesToCache,
} from "./price-cache";
import type { PriceBar } from "./types";

/** Minimal PostgREST stand-in for the egress-guard tests: one row, a
 *  select counter, and the upsert payloads as written. */
const { fakeDb } = vi.hoisted(() => ({
  fakeDb: {
    row: null as null | { bars: unknown[]; fetched_at: string },
    upsertError: null as null | { message: string },
    selects: 0,
    upserts: [] as Array<Record<string, unknown>>,
    reset() {
      this.row = null;
      this.upsertError = null;
      this.selects = 0;
      this.upserts = [];
    },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => {
        fakeDb.selects++;
        const chain = {
          eq: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: fakeDb.row, error: null }),
        };
        return chain;
      },
      upsert: async (payload: Record<string, unknown>) => {
        fakeDb.upserts.push(payload);
        if (fakeDb.upsertError) return { error: fakeDb.upsertError };
        fakeDb.row = { bars: payload.bars as unknown[], fetched_at: payload.fetched_at as string };
        return { error: null };
      },
    }),
  }),
}));

/**
 * DQ.2 (2026-07-09): one instant must map to exactly one canonical string,
 * regardless of which provider format it arrived in. The pre-fix version
 * passed any `T…Z` string through untouched, so OANDA's nanosecond ISO and
 * Twelve Data's normalised ISO never collided in savePricesToCache's dedupe
 * Map — the XAU/USD 4h row accumulated 11,169 bars across 8,838 distinct
 * instants (62 duplicates inside the live 200-bar evaluation window).
 */
describe("normalizeBarDate", () => {
  const CANONICAL = "2026-07-09T13:00:00.000Z";

  it("collapses every provider format for the same instant to one string", () => {
    expect(normalizeBarDate("2026-07-09T13:00:00.000000000Z")).toBe(CANONICAL); // OANDA ns
    expect(normalizeBarDate("2026-07-09T13:00:00Z")).toBe(CANONICAL); // pre-fix normalised
    expect(normalizeBarDate("2026-07-09T13:00:00.000Z")).toBe(CANONICAL); // already canonical
    expect(normalizeBarDate("2026-07-09 13:00:00")).toBe(CANONICAL); // Twelve Data space
    expect(normalizeBarDate("2026-07-09T13:00:00")).toBe(CANONICAL); // ISO, no TZ marker
  });

  it("pads date-only bars to midnight UTC canonical", () => {
    expect(normalizeBarDate("2007-08-03")).toBe("2007-08-03T00:00:00.000Z");
  });

  it("collapses explicit-offset inputs to their UTC instant", () => {
    expect(normalizeBarDate("2026-07-09T15:00:00+02:00")).toBe(CANONICAL);
    expect(normalizeBarDate("2026-07-09T15:00:00.500000+0200")).toBe("2026-07-09T13:00:00.500Z");
  });

  it("is idempotent", () => {
    for (const input of ["2026-07-09T13:00:00.000000000Z", "2026-07-09 13:00:00", "2007-08-03"]) {
      const once = normalizeBarDate(input);
      expect(normalizeBarDate(once)).toBe(once);
    }
  });

  it("returns unrecognised strings unchanged so downstream parsing surfaces them", () => {
    expect(normalizeBarDate("not-a-date")).toBe("not-a-date");
    expect(normalizeBarDate("07/09/2026")).toBe("07/09/2026");
  });
});

/**
 * DQ.3 (2026-07-09): the provider fallback chain served HOURLY bars under a
 * 4h cache request (observed 2026-07-07/08 in the XAU/USD 4h full row).
 * savePricesToCache rejects incoming sets whose median spacing is finer
 * than 0.75× the requested interval; medianSpacingMinutes is its measure.
 */
describe("medianSpacingMinutes", () => {
  const mkBars = (dates: string[]): PriceBar[] =>
    dates.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 0 }));

  it("medians 240 for a 4h grid even across a weekend gap", () => {
    expect(
      medianSpacingMinutes(
        mkBars([
          "2026-07-03T09:00:00.000Z",
          "2026-07-03T13:00:00.000Z",
          "2026-07-03T17:00:00.000Z",
          "2026-07-03T21:00:00.000Z",
          "2026-07-06T01:00:00.000Z", // weekend gap — median unaffected
          "2026-07-06T05:00:00.000Z",
          "2026-07-06T09:00:00.000Z",
        ])
      )
    ).toBe(240);
  });

  it("medians 60 for hourly pollution served under a 4h request", () => {
    expect(
      medianSpacingMinutes(
        mkBars([
          "2026-07-07T06:00:00.000Z",
          "2026-07-07T07:00:00.000Z",
          "2026-07-07T08:00:00.000Z",
          "2026-07-07T09:00:00.000Z",
        ])
      )
    ).toBe(60);
  });

  it("returns null when fewer than 3 bars", () => {
    expect(medianSpacingMinutes(mkBars(["2026-07-07T06:00:00.000Z"]))).toBeNull();
    expect(
      medianSpacingMinutes(mkBars(["2026-07-07T06:00:00.000Z", "2026-07-07T10:00:00.000Z"]))
    ).toBeNull();
  });
});

/**
 * DQ.4 (E2.25.a, 2026-07-17): write-side quality guards. The Twelve Data
 * fallback incident passed DQ.3 (correct 4h spacing) and still poisoned
 * the row — these rules are the ones that would have stopped it.
 */
describe("filterIncomingBars (DQ.4)", () => {
  const bar = (date: string, volume = 100): PriceBar => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume,
  });
  // NY-aligned 4h grid (summer): starts 01/05/09/13/17/21 UTC.
  const nyGrid = (n: number): PriceBar[] => {
    const out: PriceBar[] = [];
    let t = Date.parse("2026-06-01T01:00:00.000Z");
    for (let i = 0; i < n; i++) {
      const d = new Date(t);
      if (d.getUTCDay() !== 6 && d.getUTCDay() !== 0) out.push(bar(d.toISOString()));
      t += 4 * 3600_000;
    }
    return out;
  };
  const NOW = Date.parse("2026-07-17T14:45:00.000Z");

  it("drops a still-forming tail bar (the 13:00Z bar written at 14:45Z)", () => {
    const { kept, dropped } = filterIncomingBars(
      [bar("2026-07-17T09:00:00.000Z"), bar("2026-07-17T13:00:00.000Z")],
      nyGrid(200),
      "4h",
      NOW
    );
    expect(dropped.forming).toBe(1);
    expect(kept.map((b) => b.date)).toEqual(["2026-07-17T09:00:00.000Z"]);
  });

  it("drops Saturday and early-Sunday bars (gold does not trade them)", () => {
    const { kept, dropped } = filterIncomingBars(
      [
        bar("2026-07-11T01:00:00.000Z"), // Saturday
        bar("2026-07-12T05:00:00.000Z"), // Sunday 05:00 — closed
        bar("2026-07-12T21:00:00.000Z"), // Sunday 21:00 — legit open
      ],
      nyGrid(200),
      "4h",
      NOW
    );
    expect(dropped.weekend).toBe(2);
    expect(kept.map((b) => b.date)).toEqual(["2026-07-12T21:00:00.000Z"]);
  });

  it("drops off-grid phases when the row has an established grid", () => {
    // Existing row is NY-aligned (01/05/09/...); incoming UTC-aligned
    // (00/04/08/...) — the phantom-instants class.
    const { kept, dropped } = filterIncomingBars(
      [
        bar("2026-07-14T00:00:00.000Z"),
        bar("2026-07-14T04:00:00.000Z"),
        bar("2026-07-14T05:00:00.000Z"),
      ],
      nyGrid(200),
      "4h",
      NOW
    );
    expect(dropped.offGrid).toBe(2);
    expect(kept.map((b) => b.date)).toEqual(["2026-07-14T05:00:00.000Z"]);
  });

  it("applies no phase filter on a thin existing row (<100 bars)", () => {
    const { kept, dropped } = filterIncomingBars(
      [bar("2026-07-14T00:00:00.000Z")],
      nyGrid(20),
      "4h",
      NOW
    );
    expect(dropped.offGrid).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it("keeps everything on a clean same-grid weekday payload", () => {
    const { kept, dropped } = filterIncomingBars(
      [bar("2026-07-16T09:00:00.000Z"), bar("2026-07-16T13:00:00.000Z")],
      nyGrid(200),
      "4h",
      NOW
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual({ forming: 0, weekend: 0, offGrid: 0 });
  });
});

/**
 * E2.34 (2026-10-19): egress guard. The 2026-10-13 Supabase free-tier
 * lockout came from (a) a 100K-bar cap that let OANDA `full` refreshes
 * re-inflate the hand-trimmed live rows to ~5,200 bars (636KB on the wire)
 * and (b) five sibling algos each pulling the whole row every scan tick,
 * plus a pre-upsert re-read on every write. These pin the fix.
 */
describe("egress guard (E2.34)", () => {
  const bar = (date: string, volume = 100): PriceBar => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume,
  });
  /** NY-aligned 4h weekday grid ending well before NOW so DQ.4 keeps
   *  every bar (no forming / weekend / off-grid drops). */
  const grid4h = (n: number, endIso = "2026-10-09T21:00:00.000Z"): PriceBar[] => {
    const out: PriceBar[] = [];
    let t = Date.parse(endIso);
    while (out.length < n) {
      const d = new Date(t);
      if (d.getUTCDay() !== 6 && d.getUTCDay() !== 0) out.unshift(bar(d.toISOString()));
      t -= 4 * 3600_000;
    }
    return out;
  };
  const NOW = new Date("2026-10-19T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    fakeDb.reset();
    _resetPriceCacheRowCopiesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the cap is the 2,000-bar operational depth (not the old 100K)", () => {
    expect(MAX_BARS_PER_ROW).toBe(2_000);
  });

  it("caps a row at MAX_BARS_PER_ROW on write, keeping the NEWEST bars", async () => {
    const incoming = grid4h(MAX_BARS_PER_ROW + 500);
    await savePricesToCache("XAU/USD", "full", incoming, "4h");
    expect(fakeDb.upserts).toHaveLength(1);
    const written = fakeDb.upserts[0].bars as PriceBar[];
    expect(written).toHaveLength(MAX_BARS_PER_ROW);
    expect(written[0].date).toBe(incoming[500].date);
    expect(written[written.length - 1].date).toBe(incoming[incoming.length - 1].date);
    expect(fakeDb.upserts[0].bar_count).toBe(MAX_BARS_PER_ROW);
  });

  it("a merge over an already-full row stays capped (the refresh that re-inflated live)", async () => {
    const existing = grid4h(MAX_BARS_PER_ROW);
    fakeDb.row = { bars: existing, fetched_at: NOW.toISOString() };
    // Provider `full` refresh: 5,000 bars overlapping the row + 12 new ones.
    const refresh = grid4h(5_000, "2026-10-12T21:00:00.000Z");
    await savePricesToCache("XAU/USD", "full", refresh, "4h");
    const written = fakeDb.upserts[0].bars as PriceBar[];
    expect(written).toHaveLength(MAX_BARS_PER_ROW);
    expect(written[written.length - 1].date).toBe("2026-10-12T21:00:00.000Z");
  });

  it("sibling reads share one DB read per key (in-process row copy)", async () => {
    fakeDb.row = { bars: grid4h(50), fetched_at: NOW.toISOString() };
    const a = await getCachedPrices("XAU/USD", "full", "4h");
    const b = await getCachedPrices("xau/usd", "full", "4h");
    const c = await getCachedPrices("XAU/USD", "full", "4h");
    expect(a).toHaveLength(50);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fakeDb.selects).toBe(1);
  });

  it("applies the fetched_at TTL to in-process hits too (expired row → null, not a stale hit)", async () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    fakeDb.row = { bars: grid4h(50), fetched_at: twoHoursAgo };
    expect(await getCachedPrices("XAU/USD", "full", "4h")).toBeNull(); // 1h intraday TTL
    expect(await getCachedPrices("XAU/USD", "full", "4h")).toBeNull();
    expect(fakeDb.selects).toBe(1);
    // The same age is well inside the 7-day daily TTL.
    _resetPriceCacheRowCopiesForTests();
    expect(await getCachedPrices("XAU/USD", "full", "1day")).toHaveLength(50);
  });

  it("re-reads the DB once the in-process copy ages past its TTL", async () => {
    fakeDb.row = { bars: grid4h(50), fetched_at: NOW.toISOString() };
    await getCachedPrices("XAU/USD", "full", "4h");
    vi.advanceTimersByTime(9 * 60_000);
    await getCachedPrices("XAU/USD", "full", "4h");
    expect(fakeDb.selects).toBe(1);
    vi.advanceTimersByTime(2 * 60_000);
    await getCachedPrices("XAU/USD", "full", "4h");
    expect(fakeDb.selects).toBe(2);
  });

  it("write-through: a save merges against the row copy (no pre-upsert re-read) and later reads come from memory", async () => {
    const existing = grid4h(120);
    fakeDb.row = { bars: existing, fetched_at: NOW.toISOString() };
    await getCachedPrices("XAU/USD", "full", "4h");
    expect(fakeDb.selects).toBe(1);

    // Provider refresh overlapping the tail + 6 new bars.
    const refresh = grid4h(30, "2026-10-12T21:00:00.000Z");
    await savePricesToCache("XAU/USD", "full", refresh, "4h");
    expect(fakeDb.selects).toBe(1); // merge base came from the copy
    expect(fakeDb.upserts).toHaveLength(1);
    const written = fakeDb.upserts[0].bars as PriceBar[];
    expect(written).toHaveLength(126);

    const after = await getCachedPrices("XAU/USD", "full", "4h");
    expect(after).toHaveLength(126);
    expect(after?.[after.length - 1].date).toBe("2026-10-12T21:00:00.000Z");
    expect(fakeDb.selects).toBe(1);
  });

  it("the refreshed tail is visible to the next reader BEFORE the upsert settles", async () => {
    fakeDb.row = { bars: grid4h(120), fetched_at: NOW.toISOString() };
    await getCachedPrices("XAU/USD", "full", "4h");
    const refresh = grid4h(30, "2026-10-12T21:00:00.000Z");
    // Fire-and-forget, exactly how getFreshPricesForScan calls it.
    const pending = savePricesToCache("XAU/USD", "full", refresh, "4h");
    const sibling = await getCachedPrices("XAU/USD", "full", "4h");
    expect(sibling?.[sibling.length - 1].date).toBe("2026-10-12T21:00:00.000Z");
    await pending;
  });

  it("a failed upsert warns and keeps the provider bars in-process (DB row stays one refresh behind)", async () => {
    fakeDb.row = { bars: grid4h(120), fetched_at: NOW.toISOString() };
    await getCachedPrices("XAU/USD", "full", "4h");
    fakeDb.upsertError = { message: "exceed_egress_quota" };
    const refresh = grid4h(30, "2026-10-12T21:00:00.000Z");
    await expect(savePricesToCache("XAU/USD", "full", refresh, "4h")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("upsert XAU/USD 4h failed"));
    const after = await getCachedPrices("XAU/USD", "full", "4h");
    expect(after).toHaveLength(126);
  });
});
