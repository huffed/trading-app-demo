/**
 * Integration tests for the alpha-decay cron route handler.
 * Locks: 0-active-algos no-op path, healthy → no pause, decay → pause SQL fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api/admin-auth", () => ({
  verifyAdminAuth: vi.fn(() => null),
}));

const evaluateAndApplyMock = vi.fn();
vi.mock("@/lib/cohort/alpha-decay", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cohort/alpha-decay")>("@/lib/cohort/alpha-decay");
  return {
    ...actual,
    evaluateAndApplyAlphaDecay: (...args: unknown[]) => evaluateAndApplyMock(...args),
  };
});

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { GET } from "./route";

function makeRequest() {
  return new Request("http://test/api/cron/alpha-decay", {
    method: "GET",
    headers: { Authorization: "Bearer test" },
  });
}

describe("alpha-decay route", () => {
  beforeEach(() => {
    evaluateAndApplyMock.mockReset();
    createAdminClientMock.mockReset();
    createAdminClientMock.mockReturnValue({});
  });

  it("0 active algos → returns {evaluated:0, paused:0} + no-op message", async () => {
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T09:00:00Z",
      evaluated: 0,
      per_algo: [],
      paused: [],
      counts: { none: 0, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0 },
    });
    const body = await (await GET(makeRequest())).json();
    expect(body).toEqual({
      evaluated: 0,
      paused: 0,
      message: "no active algos — alpha-decay check skipped (heartbeat emitted)",
    });
  });

  it("evaluated algos → response includes counts + paused list", async () => {
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T09:00:00Z",
      evaluated: 3,
      per_algo: [],
      paused: [{ algorithm_id: "a1", algorithm_name: "Decayed", reason: "Sustained decay" }],
      counts: { none: 2, warn: 0, decay: 1, insufficient_data: 0, no_baseline: 0 },
    });
    const body = await (await GET(makeRequest())).json();
    expect(body.evaluated).toBe(3);
    expect(body.paused).toBe(1);
    expect(body.counts).toEqual({ none: 2, warn: 0, decay: 1, insufficient_data: 0, no_baseline: 0 });
    expect(body.paused_algos).toHaveLength(1);
  });

  it("propagates errors as 500 with code", async () => {
    evaluateAndApplyMock.mockRejectedValue(new Error("DB down"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "DB down", code: "alpha_decay_tick_failed" });
  });

  it("emits an alpha_decay_tick liveness heartbeat on a successful run (E2.25.i)", async () => {
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T09:00:00Z",
      evaluated: 5,
      per_algo: [],
      paused: [],
      counts: { none: 5, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0 },
    });
    // Minimal supabase stub covering pickHeartbeatUserId (algorithms →
    // user_id) + logActivity (insert into activity_log).
    const inserted: Array<Record<string, unknown>> = [];
    createAdminClientMock.mockReturnValue({
      from: (table: string) => {
        if (table === "algorithms") {
          return { select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { user_id: "u1" } }) }) }) };
        }
        if (table === "activity_log") {
          return { insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } };
        }
        throw new Error(`unexpected table ${table}`);
      },
    });
    await GET(makeRequest());
    const tick = inserted.find((r) => r.event_type === "alpha_decay_tick");
    expect(tick).toBeDefined();
    expect(tick).toMatchObject({ event_type: "alpha_decay_tick", details: { evaluated: 5, paused: 0 } });
  });

  it("a broken heartbeat write never fails the tick (best-effort)", async () => {
    evaluateAndApplyMock.mockResolvedValue({
      generated_at: "2026-06-23T09:00:00Z",
      evaluated: 2,
      per_algo: [],
      paused: [],
      counts: { none: 2, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0 },
    });
    createAdminClientMock.mockReturnValue({
      from: () => { throw new Error("heartbeat DB exploded"); },
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evaluated).toBe(2); // tick succeeded despite the heartbeat throwing
  });
});
