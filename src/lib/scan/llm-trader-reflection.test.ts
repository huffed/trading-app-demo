/**
 * CB.T1 Tier 3 — llm-trader-reflection.ts (2026-06-23).
 *
 * Recent-outcomes summary for in-context LLM reflection. Tests:
 *   - <10 closed trades → returns null (insufficient n)
 *   - ≥10 trades → returns summary string
 *   - Regime aggregation: groups by regime tag from llm_decisions join
 *   - Slumping flag: WR <25% on ≥3 trades for a regime → in summary
 *   - "?"/"n/a" regimes filtered from regime breakdown
 *   - Query error → returns null (don't fail loudly in reflection layer)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summariseRecentOutcomes } from "./llm-trader-reflection";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FixtureRow {
  realized_pnl: number | null;
  side: "long" | "short" | null;
  closed_at: string | null;
  llm_decisions: { regime: string | null; decision: string | null } | Array<{ regime: string | null; decision: string | null }> | null;
}

function makeSupabase(opts: { rows?: FixtureRow[] | null; error?: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.not = vi.fn().mockReturnValue(builder);
  builder.order = vi.fn().mockReturnValue(builder);
  builder.limit = vi.fn().mockImplementation(() =>
    Promise.resolve({ data: opts.rows ?? [], error: opts.error ?? null })
  );
  const fromMock = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(builder) });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return stub as unknown as SupabaseClient;
}

function trade(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    realized_pnl: 50,
    side: "long",
    closed_at: "2026-06-22T00:00:00Z",
    llm_decisions: { regime: "HH", decision: "enter_long" },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("summariseRecentOutcomes", () => {
  it("<10 trades → returns null (insufficient n)", async () => {
    const rows = Array.from({ length: 9 }, () => trade());
    expect(await summariseRecentOutcomes(makeSupabase({ rows }), "algo-1")).toBeNull();
  });

  it("0 trades → returns null", async () => {
    expect(await summariseRecentOutcomes(makeSupabase({ rows: [] }), "algo-1")).toBeNull();
  });

  it("query error → returns null (graceful — don't fail loudly in reflection layer)", async () => {
    expect(
      await summariseRecentOutcomes(makeSupabase({ rows: null, error: { message: "boom" } }), "algo-1")
    ).toBeNull();
  });

  it("≥10 trades → returns RECENT TRACK RECORD summary string", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => trade({ realized_pnl: i < 4 ? 100 : -50 }));
    const r = await summariseRecentOutcomes(makeSupabase({ rows }), "algo-1");
    expect(r).not.toBeNull();
    expect(r!).toContain("RECENT TRACK RECORD");
    expect(r!).toContain("4W/6L");
    expect(r!).toContain("40% WR");
  });

  it("regime breakdown sorted by trade count desc + excludes ?/n/a", async () => {
    const rows: FixtureRow[] = [
      ...Array.from({ length: 6 }, () => trade({ llm_decisions: { regime: "HH", decision: "enter_long" } })),
      ...Array.from({ length: 3 }, () => trade({ llm_decisions: { regime: "LH", decision: "enter_short" } })),
      ...Array.from({ length: 2 }, () => trade({ llm_decisions: { regime: "n/a", decision: "enter_long" } })),
    ];
    const r = await summariseRecentOutcomes(makeSupabase({ rows }), "algo-1");
    // n/a regime should NOT appear; HH should appear before LH (more trades)
    expect(r!).toContain("HH");
    expect(r!).toContain("LH");
    expect(r!).not.toContain("n/a");
    expect(r!.indexOf("HH")).toBeLessThan(r!.indexOf("LH"));
  });

  it("slumping flag: WR <25% on ≥3 trades for a regime → 'unfavorable in current regime'", async () => {
    // 11 trades total: 8 HH (1W/7L = 12.5% WR), 3 LH (3W = 100% WR)
    const rows: FixtureRow[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        trade({ llm_decisions: { regime: "HH", decision: "enter_long" }, realized_pnl: i === 0 ? 100 : -50 })
      ),
      ...Array.from({ length: 3 }, () =>
        trade({ llm_decisions: { regime: "LH", decision: "enter_short" }, realized_pnl: 100 })
      ),
    ];
    const r = await summariseRecentOutcomes(makeSupabase({ rows }), "algo-1");
    expect(r!).toContain("HH setups appear unfavorable");
  });
});
