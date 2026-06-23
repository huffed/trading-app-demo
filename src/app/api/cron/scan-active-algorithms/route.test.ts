/**
 * Integration tests for the scan-active-algorithms cron route handler.
 * Locks the SG.19 cron-idle path: when 0 active algos exist, the route
 * MUST call emitCronIdle("scan") and surface the emit status in the
 * response (so a future regression that silently drops the emit is
 * caught immediately rather than rediscovered weeks later via a dead
 * GitHub Actions dead-man job).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

const emitCronIdleMock = vi.fn();
vi.mock("@/lib/scan/cron-idle", () => ({
  emitCronIdle: (...args: unknown[]) => emitCronIdleMock(...args),
}));

const scanAlgorithmMock = vi.fn();
vi.mock("@/lib/scan/engine", () => ({
  scanAlgorithm: (...args: unknown[]) => scanAlgorithmMock(...args),
}));

vi.mock("@/lib/scan/portfolio-halt", () => ({
  checkPortfolioHalt: vi.fn(async () => null),
  executePortfolioHalt: vi.fn(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

vi.mock("@/lib/supabase/row-mappers", () => ({
  portfoliosFromRows: vi.fn((rows: unknown[]) => rows),
  rulesFromRow: vi.fn((r: unknown) => r),
}));

import { GET } from "./route";

/** Build a minimal admin-client stub that returns `algoRows` for the
 *  algorithms.select(...).eq("status","active") chain. */
function fakeAdminClient(algoRows: unknown[]) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => Promise.resolve({ data: algoRows, error: null }),
        in: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  };
}

function makeRequest() {
  return new Request("http://test/api/cron/scan-active-algorithms", {
    method: "GET",
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("scan-active-algorithms route (SG.19 cron-idle path)", () => {
  beforeEach(() => {
    emitCronIdleMock.mockReset();
    scanAlgorithmMock.mockReset();
    createAdminClientMock.mockReset();
  });

  it("emits cron_idle for scan when 0 active algos + returns scanned:0", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient([]));
    emitCronIdleMock.mockResolvedValue({ emitted: true });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(emitCronIdleMock).toHaveBeenCalledOnce();
    expect(emitCronIdleMock).toHaveBeenCalledWith(expect.anything(), "scan");
    expect(body).toEqual({
      scanned: 0,
      results: [],
      cron_idle_emitted: true,
      cron_idle_skipped_reason: undefined,
    });
    expect(scanAlgorithmMock).not.toHaveBeenCalled();
  });

  it("surfaces emit-skipped reason when no user_id resolvable", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient([]));
    emitCronIdleMock.mockResolvedValue({
      emitted: false,
      skipped_reason: "no_user_id_available",
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.cron_idle_emitted).toBe(false);
    expect(body.cron_idle_skipped_reason).toBe("no_user_id_available");
  });

  it("does NOT emit cron_idle when ≥1 active algo exists", async () => {
    const algoRow = {
      id: "a1",
      user_id: "u1",
      name: "Test",
      description: null,
      rules: { entry_conditions: [], position_sizing: { type: "risk_per_trade", value: 1 } },
      capital: 10000,
      status: "active",
      live_trading_enabled: false,
      broker_connection_id: null,
      portfolio_id: null,
      algorithm_watchlist: [],
    };
    createAdminClientMock.mockReturnValue(fakeAdminClient([algoRow]));
    scanAlgorithmMock.mockResolvedValue({
      algorithm_id: "a1",
      opened_details: [],
      closed_details: [],
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(emitCronIdleMock).not.toHaveBeenCalled();
    expect(body.scanned).toBe(1);
    expect(scanAlgorithmMock).toHaveBeenCalledOnce();
  });
});
