/**
 * Integration tests for the manage-positions cron route handler.
 * Locks SG.19: when no active algo exists, the route MUST call
 * emitCronIdle("manage") instead of skipping silently.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

const emitCronIdleMock = vi.fn();
vi.mock("@/lib/scan/cron-idle", () => ({
  emitCronIdle: (...args: unknown[]) => emitCronIdleMock(...args),
}));

const manageActiveAlgosMock = vi.fn();
vi.mock("@/lib/scan/manage", () => ({
  manageActiveAlgorithms: (...args: unknown[]) => manageActiveAlgosMock(...args),
}));

const logActivityMock = vi.fn();
vi.mock("@/lib/scan/helpers", () => ({
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET } from "./route";

/** Build a stub whose algorithms.select(user_id).eq("status","active")
 *  .limit(1).maybeSingle() returns whatever the test supplies. */
function fakeAdminClient(maybeSingleRow: { user_id: string } | null) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: () => Promise.resolve({ data: maybeSingleRow, error: null }),
          }),
        }),
      }),
    }),
  };
}

function makeRequest() {
  return new Request("http://test/api/cron/manage-positions", {
    method: "GET",
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("manage-positions route (SG.19 cron-idle path)", () => {
  beforeEach(() => {
    emitCronIdleMock.mockReset();
    manageActiveAlgosMock.mockReset();
    logActivityMock.mockReset();
    createAdminClientMock.mockReset();
    manageActiveAlgosMock.mockResolvedValue([]); // default: no algos walked
  });

  it("emits cron_idle for manage when 0 active algos exist", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient(null));
    emitCronIdleMock.mockResolvedValue({ emitted: true });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(emitCronIdleMock).toHaveBeenCalledOnce();
    expect(emitCronIdleMock).toHaveBeenCalledWith(expect.anything(), "manage");
    expect(logActivityMock).not.toHaveBeenCalled(); // manage_tick NOT written
    expect(body.cron_idle_emitted).toBe(true);
    expect(body.algorithms).toBe(0);
  });

  it("writes manage_tick (NOT cron_idle) when ≥1 active algo exists", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient({ user_id: "u1" }));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(logActivityMock).toHaveBeenCalledOnce();
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      expect.objectContaining({ event_type: "manage_tick", algorithm_id: null }),
    );
    expect(emitCronIdleMock).not.toHaveBeenCalled();
    expect(body.cron_idle_emitted).toBe(false);
  });
});
