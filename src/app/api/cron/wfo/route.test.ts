/**
 * G.5 wfo cron route — locks DRY_RUN default + query-string flip semantics.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

const evaluateAndApplyMock = vi.fn();
vi.mock("@/lib/algo-search/walk-forward-opt", async () => {
  const actual = await vi.importActual<typeof import("@/lib/algo-search/walk-forward-opt")>("@/lib/algo-search/walk-forward-opt");
  return {
    ...actual,
    evaluateAndApplyWfo: (...args: unknown[]) => evaluateAndApplyMock(...args),
  };
});

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET } from "./route";

function makeRequest(query: string = "") {
  return new Request(`http://test/api/cron/wfo${query}`, {
    method: "GET",
    headers: { Authorization: "Bearer test" },
  });
}

describe("wfo route", () => {
  beforeEach(() => {
    evaluateAndApplyMock.mockReset();
    createAdminClientMock.mockReset();
    createAdminClientMock.mockReturnValue({});
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T06:00:00Z",
      dry_run: true,
      evaluated: 0,
      proposals: [],
      skipped: [],
      applied: [],
    });
  });

  it("defaults to DRY_RUN=true when no query param", async () => {
    await GET(makeRequest());
    expect(evaluateAndApplyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dry_run: true }),
    );
  });

  it("flips to DRY_RUN=false ONLY when ?dry_run=0 is explicitly passed", async () => {
    await GET(makeRequest("?dry_run=0"));
    expect(evaluateAndApplyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dry_run: false }),
    );
  });

  it("treats ?dry_run=1 / ?dry_run=true / unrecognized values as dry-run (conservative)", async () => {
    for (const v of ["1", "true", "yes", "no"]) {
      evaluateAndApplyMock.mockClear();
      await GET(makeRequest(`?dry_run=${v}`));
      expect(evaluateAndApplyMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dry_run: true }),
      );
    }
  });

  it("returns proposal/skipped/applied counts in the body", async () => {
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T06:00:00Z",
      dry_run: true,
      evaluated: 3,
      proposals: [{
        algorithm_id: "a1", algorithm_name: "x", current_geometry: null, current_dsr: 0.5,
        best_geometry: { rr_multiple: 3, sl_lookback: 6, risk_per_trade_pct: 0.6, regime_filter: false, adx_filter: false },
        best_dsr: 0.55, family_sharpe_std: 0.04, family_size: 96, dsr_improvement: 0.05,
        passes_buffer: false, rules_changed: false,
        proposed_rules: {} as never, trades_in_window: 100, window_start: "x", window_end: "y",
      }],
      skipped: [{ algorithm_id: "a2", algorithm_name: "y", reason: "no_layer_b_geometry", detail: "..." }],
      applied: [],
    });
    const body = await (await GET(makeRequest())).json();
    expect(body.evaluated).toBe(3);
    expect(body.proposal_count).toBe(1);
    expect(body.skipped_count).toBe(1);
    expect(body.applied_count).toBe(0);
    expect(body.proposals[0].algorithm_id).toBe("a1");
    expect(body.skipped[0].reason).toBe("no_layer_b_geometry");
  });

  it("propagates errors as 500 with code", async () => {
    evaluateAndApplyMock.mockRejectedValue(new Error("DB exploded"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "DB exploded", code: "wfo_tick_failed" });
  });
});
