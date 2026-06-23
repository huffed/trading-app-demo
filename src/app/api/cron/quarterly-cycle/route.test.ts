/**
 * H.5 quarterly-cycle route — locks the JSON response shape + error path.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

const buildReportMock = vi.fn();
vi.mock("@/lib/cohort/quarterly-cycle", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cohort/quarterly-cycle")>("@/lib/cohort/quarterly-cycle");
  return {
    ...actual,
    buildQuarterlyCycleReport: (...args: unknown[]) => buildReportMock(...args),
  };
});

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET } from "./route";

function makeRequest() {
  return new Request("http://test/api/cron/quarterly-cycle", {
    method: "GET",
    headers: { Authorization: "Bearer test" },
  });
}

describe("quarterly-cycle route", () => {
  beforeEach(() => {
    buildReportMock.mockReset();
    createAdminClientMock.mockReset();
    createAdminClientMock.mockReturnValue({});
  });

  it("returns the report payload + markdown in response body", async () => {
    buildReportMock.mockResolvedValue({
      cycle_id: "2026-Q3",
      generated_at: "2026-07-01T00:00:00Z",
      next_cycle_at: "2026-10-01T00:00:00Z",
      feature_library: { total_count: 48, by_category: {}, feature_names: [] },
      alpha_library: [{ algorithm_id: "a1", algorithm_name: "x" }],
      decay: { evaluated: 3, counts: { decay: 1, warn: 0, none: 2, insufficient_data: 0, no_baseline: 0 } },
      markdown: "# Quarterly Research Cycle — 2026-Q3\n",
    });
    const body = await (await GET(makeRequest())).json();
    expect(body.cycle_id).toBe("2026-Q3");
    expect(body.feature_count).toBe(48);
    expect(body.alpha_count).toBe(1);
    expect(body.decay_evaluated).toBe(3);
    expect(body.decay_counts.decay).toBe(1);
    expect(body.markdown).toContain("Quarterly Research Cycle — 2026-Q3");
    // File path is /tmp/quanttrader-cycles/2026-Q3-research-cycle.md when fs write succeeds
    expect(body.file_path).toBe("/tmp/quanttrader-cycles/2026-Q3-research-cycle.md");
  });

  it("propagates errors as 500 with code", async () => {
    buildReportMock.mockRejectedValue(new Error("DB down"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "DB down", code: "quarterly_cycle_tick_failed" });
  });
});
