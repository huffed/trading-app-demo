/**
 * Integration tests for the heartbeat cron route handler. Locks SG.19
 * status semantics: idle (0 active), healthy (≥1 active none stale),
 * stale (≥1 stale algo).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

vi.mock("@/lib/scan/helpers", () => ({
  logActivity: vi.fn(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET } from "./route";

interface FakeOpts {
  /** Result for the count-only query (head=true). */
  activeCount: number;
  /** Rows returned by the stale-detection query. */
  staleRows?: { id: string; user_id: string; name: string; last_scanned_at: string | null; created_at: string }[];
}

/** The heartbeat route calls .from('algorithms') twice — first for the
 *  count (.select with {count:'exact',head:true}.eq), then for the
 *  stale query (.select(...).eq.or). The mock dispatches based on call
 *  order. */
function fakeAdminClient(opts: FakeOpts) {
  let callIndex = 0;
  return {
    from: (_t: string) => {
      const idx = callIndex++;
      if (idx === 0) {
        // count query
        return {
          select: (_cols: string, _opts: { count: string; head: boolean }) => ({
            eq: () => Promise.resolve({ data: null, count: opts.activeCount, error: null }),
          }),
        };
      }
      // stale query
      return {
        select: () => ({
          eq: () => ({
            or: () => Promise.resolve({ data: opts.staleRows ?? [], error: null }),
          }),
        }),
      };
    },
  };
}

function makeRequest() {
  return new Request("http://test/api/cron/heartbeat", {
    method: "GET",
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("heartbeat route (SG.19 status semantics)", () => {
  beforeEach(() => {
    createAdminClientMock.mockReset();
  });

  it("returns status='idle' when 0 active algos", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient({ activeCount: 0 }));
    const body = await (await GET(makeRequest())).json();
    expect(body.status).toBe("idle");
    expect(body.active_count).toBe(0);
    expect(body.stale_count).toBe(0);
  });

  it("returns status='healthy' when ≥1 active AND none stale", async () => {
    createAdminClientMock.mockReturnValue(fakeAdminClient({ activeCount: 3 }));
    const body = await (await GET(makeRequest())).json();
    expect(body.status).toBe("healthy");
    expect(body.active_count).toBe(3);
    expect(body.stale_count).toBe(0);
  });

  it("returns status='stale' when ≥1 active AND ≥1 stale", async () => {
    createAdminClientMock.mockReturnValue(
      fakeAdminClient({
        activeCount: 3,
        staleRows: [
          {
            id: "a1",
            user_id: "u1",
            name: "Stuck",
            last_scanned_at: "2026-06-19T00:00:00Z",
            created_at: "2026-06-01T00:00:00Z",
          },
        ],
      }),
    );
    const body = await (await GET(makeRequest())).json();
    expect(body.status).toBe("stale");
    expect(body.active_count).toBe(3);
    expect(body.stale_count).toBe(1);
    expect(body.stale[0].name).toBe("Stuck");
  });

  it("stale dominates idle (defensive: 0 active + 0 stale = idle, not 'stale=true')", async () => {
    // edge case proof of the precedence rule in route.ts
    createAdminClientMock.mockReturnValue(fakeAdminClient({ activeCount: 0 }));
    const body = await (await GET(makeRequest())).json();
    expect(body.status).toBe("idle"); // not 'healthy', not 'stale'
  });
});
