/**
 * SG.5 — regression tests for buildDriftSummary (2026-06-22 NIGHT LATE).
 *
 * The shared lib that backs both the /reports Drift tab and any future
 * CLI consumer. Tests focus on:
 *
 *  - Empty-state graceful return (no algos / no events → empty arrays + zero counts)
 *  - Per-algo iteration: algos with baseline run detectDrift; algos without are flagged "no_baseline"
 *  - Sort order: halt → warn → none → no_baseline; alphabetical within severity
 *  - Severity counts add up to per_algo length (no double-counting / off-by-one)
 *  - Activity_log query: drift_halt/drift_warn filter + history_days window + event_limit
 *  - Algo name join from id → name on event rows
 *  - Error paths throw loudly (no silent empty)
 *
 * `detectDrift` itself is unit-tested in src/lib/scan/drift-detector.test.ts.
 * Here we mock it to control severity outcomes per algo without driving
 * synthetic paper_positions through the real detector. That keeps the
 * test focused on the SUMMARY layer's contract (iteration + sort + count +
 * event join) and isolates the test from any future detectDrift impl change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectDrift } from "@/lib/scan/drift-detector";
import { buildDriftSummary } from "./drift-summary";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/scan/drift-detector", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scan/drift-detector")>(
    "@/lib/scan/drift-detector"
  );
  return {
    ...actual,
    detectDrift: vi.fn(),
  };
});

const mockedDetectDrift = vi.mocked(detectDrift);

// ---- Supabase mock — dispatches by table.
//      algorithms: select.order  → terminal-thenable
//      activity_log: select.in.gte.order.limit → terminal-thenable
function makeSupabaseMock(opts: {
  algos?: Array<{
    id: string;
    name: string;
    status: string;
    backtest_results: { win_rate?: number; total_return?: number } | null;
    rules?: { drift?: { min_live_wr_pct?: number } | null } | null;
  }>;
  algosError?: { message: string } | null;
  events?: Array<{
    created_at: string;
    algorithm_id: string;
    event_type: string;
    details: unknown;
  }>;
  eventsError?: { message: string } | null;
}): { supabase: SupabaseClient; capturedActivityLogQuery: { in?: [string, unknown]; gte?: [string, unknown]; limit?: number } } {
  const captured: { in?: [string, unknown]; gte?: [string, unknown]; limit?: number } = {};

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "algorithms") {
      const builder: Record<string, unknown> = {};
      builder.order = vi.fn().mockImplementation(() =>
        Promise.resolve({
          data: opts.algos ?? [],
          error: opts.algosError ?? null,
        })
      );
      return { select: vi.fn().mockReturnValue(builder) };
    }
    if (table === "activity_log") {
      const builder: Record<string, unknown> = {};
      builder.in = vi.fn().mockImplementation((col: string, vals: unknown) => {
        captured.in = [col, vals];
        return builder;
      });
      builder.gte = vi.fn().mockImplementation((col: string, val: unknown) => {
        captured.gte = [col, val];
        return builder;
      });
      builder.order = vi.fn().mockReturnValue(builder);
      builder.limit = vi.fn().mockImplementation((n: number) => {
        captured.limit = n;
        return Promise.resolve({
          data: opts.events ?? [],
          error: opts.eventsError ?? null,
        });
      });
      return { select: vi.fn().mockReturnValue(builder) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, capturedActivityLogQuery: captured };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: detectDrift returns severity="none" for any call
  mockedDetectDrift.mockResolvedValue({
    severity: "none",
    reason: "Within range",
    recent: { trades: 12, win_rate: 60, net_pnl: 200 },
    baseline: { win_rate: 55, total_return: 1500 },
  });
});

// ======================================================================
// Empty-state graceful return
// ======================================================================

describe("buildDriftSummary — empty-state graceful return", () => {
  it("zero algos → empty per_algo + zero severity counts + empty events", async () => {
    const { supabase } = makeSupabaseMock({ algos: [], events: [] });
    const r = await buildDriftSummary(supabase);
    expect(r.per_algo).toEqual([]);
    expect(r.severity_counts).toEqual({ none: 0, warn: 0, halt: 0, no_baseline: 0 });
    expect(r.recent_events).toEqual([]);
    expect(r.history_days).toBe(30);
  });

  it("algos present + zero events → per_algo populated + events empty", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [
        { id: "a1", name: "Algo One", status: "paused", backtest_results: { win_rate: 55, total_return: 1000 } },
      ],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    expect(r.per_algo).toHaveLength(1);
    expect(r.recent_events).toEqual([]);
  });
});

// ======================================================================
// Per-algo iteration + baseline handling
// ======================================================================

describe("buildDriftSummary — per-algo iteration + baseline handling", () => {
  it("algo with baseline → detectDrift called + result threaded into per_algo entry", async () => {
    mockedDetectDrift.mockResolvedValueOnce({
      severity: "warn",
      reason: "WR drift: recent 40% vs baseline 60% (-20pp)",
      recent: { trades: 25, win_rate: 40, net_pnl: -150 },
      baseline: { win_rate: 60, total_return: 2000 },
    });
    const { supabase } = makeSupabaseMock({
      algos: [{ id: "a1", name: "Test Algo", status: "active", backtest_results: { win_rate: 60, total_return: 2000 } }],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    expect(mockedDetectDrift).toHaveBeenCalledTimes(1);
    expect(r.per_algo[0]).toMatchObject({
      algorithm_id: "a1",
      algorithm_name: "Test Algo",
      severity: "warn",
      reason: "WR drift: recent 40% vs baseline 60% (-20pp)",
      recent_trades: 25,
      recent_win_rate: 40,
      baseline_win_rate: 60,
      algo_status: "active",
    });
  });

  it("algo without baseline (null backtest_results) → skipped detectDrift, flagged no_baseline", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [{ id: "a1", name: "Empty", status: "paused", backtest_results: null }],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    expect(mockedDetectDrift).not.toHaveBeenCalled();
    expect(r.per_algo[0]).toMatchObject({
      algorithm_id: "a1",
      severity: "none",
      reason: "No backtest baseline — drift check skipped",
      baseline_win_rate: null,
    });
    expect(r.severity_counts.no_baseline).toBe(1);
  });

  it("algo with backtest_results but no win_rate field → flagged no_baseline (drift can't compute)", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [{ id: "a1", name: "Partial", status: "paused", backtest_results: { total_return: 100 } }],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    expect(mockedDetectDrift).not.toHaveBeenCalled();
    expect(r.severity_counts.no_baseline).toBe(1);
  });
});

// ======================================================================
// Sort order: halt → warn → none → no_baseline; alphabetical within severity
// ======================================================================

describe("buildDriftSummary — sort order", () => {
  it("severity ranking: halt → warn → none → no_baseline; alphabetical within", async () => {
    // 5 algos: 2 halt (alphabetic Apple→Banana), 1 warn, 1 none, 1 no_baseline.
    // Mocked detectDrift returns severity based on algo name pattern.
    mockedDetectDrift.mockImplementation(async (_sb, algoId) => {
      const name = algoId; // we use id as marker
      let severity: "halt" | "warn" | "none";
      if (name.startsWith("halt-")) severity = "halt";
      else if (name.startsWith("warn-")) severity = "warn";
      else severity = "none";
      return {
        severity,
        reason: `${severity} reason`,
        recent: { trades: 10, win_rate: 50, net_pnl: 0 },
        baseline: { win_rate: 55, total_return: 1000 },
      };
    });

    const { supabase } = makeSupabaseMock({
      algos: [
        // intentionally out of order
        { id: "none-1", name: "Charlie", status: "paused", backtest_results: { win_rate: 50, total_return: 100 } },
        { id: "halt-1", name: "Banana", status: "paused", backtest_results: { win_rate: 50, total_return: 100 } },
        { id: "nob-1", name: "Delta", status: "paused", backtest_results: null }, // no_baseline
        { id: "halt-2", name: "Apple", status: "paused", backtest_results: { win_rate: 50, total_return: 100 } },
        { id: "warn-1", name: "Echo", status: "paused", backtest_results: { win_rate: 50, total_return: 100 } },
      ],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    expect(r.per_algo.map((p) => p.algorithm_name)).toEqual(["Apple", "Banana", "Echo", "Charlie", "Delta"]);
    // Severity counts mirror what the rows show
    expect(r.severity_counts).toEqual({ halt: 2, warn: 1, none: 1, no_baseline: 1 });
  });

  it("severity counts sum equals per_algo length (no double counting)", async () => {
    mockedDetectDrift.mockResolvedValue({
      severity: "halt",
      reason: "Severe WR drift",
      recent: { trades: 20, win_rate: 10, net_pnl: -500 },
      baseline: { win_rate: 60, total_return: 2000 },
    });
    const { supabase } = makeSupabaseMock({
      algos: [
        { id: "a1", name: "Z", status: "paused", backtest_results: { win_rate: 60, total_return: 100 } },
        { id: "a2", name: "Y", status: "paused", backtest_results: null },
        { id: "a3", name: "X", status: "paused", backtest_results: { win_rate: 60, total_return: 100 } },
      ],
      events: [],
    });
    const r = await buildDriftSummary(supabase);
    const totalCount = r.severity_counts.halt + r.severity_counts.warn + r.severity_counts.none + r.severity_counts.no_baseline;
    expect(totalCount).toBe(r.per_algo.length);
  });
});

// ======================================================================
// Activity_log query construction + event payload join
// ======================================================================

describe("buildDriftSummary — activity_log query + event join", () => {
  it("activity_log query: .in(event_type, [drift_halt, drift_warn]) + .gte + .limit", async () => {
    const conf = makeSupabaseMock({ algos: [], events: [] });
    await buildDriftSummary(conf.supabase, { history_days: 7, event_limit: 100 });
    expect(conf.capturedActivityLogQuery.in).toEqual([
      "event_type",
      ["drift_halt", "drift_warn"],
    ]);
    expect(conf.capturedActivityLogQuery.gte?.[0]).toBe("created_at");
    expect(conf.capturedActivityLogQuery.limit).toBe(100);
  });

  it("event rows joined with algo name from the algorithms query", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [
        { id: "a1", name: "Joined Algo", status: "paused", backtest_results: null },
      ],
      events: [
        {
          created_at: "2026-06-20T12:34:56Z",
          algorithm_id: "a1",
          event_type: "drift_halt",
          details: {
            severity: "halt",
            reason: "Sign flip: backtest +$1000 but recent 20 trades net $-50",
            recent: { trades: 20, win_rate: 30, net_pnl: -50 },
            baseline: { win_rate: 60, total_return: 1000 },
          },
        },
      ],
    });
    const r = await buildDriftSummary(supabase);
    expect(r.recent_events).toHaveLength(1);
    expect(r.recent_events[0]).toMatchObject({
      when: "2026-06-20T12:34:56Z",
      algorithm_id: "a1",
      algorithm_name: "Joined Algo",
      event_type: "drift_halt",
      severity: "halt",
      reason: "Sign flip: backtest +$1000 but recent 20 trades net $-50",
      recent_trades: 20,
      recent_win_rate: 30,
      baseline_win_rate: 60,
    });
  });

  it("event for unknown algo_id → 'unknown' label, doesn't throw", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [],
      events: [
        {
          created_at: "2026-06-20T12:34:56Z",
          algorithm_id: "deadbeef-1234-5678-9abc-def000000000",
          event_type: "drift_warn",
          details: { reason: "test" },
        },
      ],
    });
    const r = await buildDriftSummary(supabase);
    expect(r.recent_events[0].algorithm_name).toContain("unknown");
    expect(r.recent_events[0].algorithm_name).toContain("deadbeef");
  });

  it("event with missing details fields → defaults to undefined, doesn't throw", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [{ id: "a1", name: "X", status: "paused", backtest_results: null }],
      events: [
        {
          created_at: "2026-06-20T12:34:56Z",
          algorithm_id: "a1",
          event_type: "drift_halt",
          details: null,
        },
      ],
    });
    const r = await buildDriftSummary(supabase);
    expect(r.recent_events[0]).toMatchObject({
      severity: "unknown",
      reason: "(no reason recorded)",
      recent_trades: undefined,
    });
  });
});

// ======================================================================
// Error paths
// ======================================================================

describe("buildDriftSummary — error paths", () => {
  it("algorithms query error → throws (loud failure, not silent empty)", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [],
      algosError: { message: "connection lost" },
    });
    await expect(buildDriftSummary(supabase)).rejects.toThrow(/algorithms query failed/);
  });

  it("activity_log query error → throws (loud failure)", async () => {
    const { supabase } = makeSupabaseMock({
      algos: [{ id: "a1", name: "X", status: "paused", backtest_results: null }],
      events: [],
      eventsError: { message: "history table locked" },
    });
    await expect(buildDriftSummary(supabase)).rejects.toThrow(/activity_log query failed/);
  });
});

// ======================================================================
// Options echo + history_days default
// ======================================================================

describe("buildDriftSummary — options echo", () => {
  it("history_days default = 30 + event_limit default = 50", async () => {
    const conf = makeSupabaseMock({ algos: [], events: [] });
    const r = await buildDriftSummary(conf.supabase);
    expect(r.history_days).toBe(30);
    expect(conf.capturedActivityLogQuery.limit).toBe(50);
  });

  it("history_days override → echoed back + .gte threshold shifted accordingly", async () => {
    const conf = makeSupabaseMock({ algos: [], events: [] });
    const beforeMs = Date.now() - 14 * 86_400_000;
    const r = await buildDriftSummary(conf.supabase, { history_days: 14 });
    expect(r.history_days).toBe(14);
    const gteMs = new Date(conf.capturedActivityLogQuery.gte?.[1] as string).getTime();
    // gte should be approximately NOW - 14d (within 1 sec test execution time)
    expect(Math.abs(gteMs - beforeMs)).toBeLessThan(1000);
  });
});
