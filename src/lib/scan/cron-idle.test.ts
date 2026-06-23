/**
 * Tests for cron-idle.ts — the 0-active-algos heartbeat emit.
 * Locks: user_id resolution order (algorithms → auth.users → null),
 * activity_log payload shape (event_type + cron tag + algorithm_id=null).
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitCronIdle } from "./cron-idle";

interface FakeOpts {
  /** Row returned by `algorithms LIMIT 1` (any status). */
  algoRow?: { user_id: string } | null;
  /** Row returned by auth.users fallback. Only consulted when algoRow is null. */
  authUser?: { id: string } | null;
  /** Force the auth.users call to throw (simulates RLS/admin denial). */
  authThrows?: boolean;
}

/** Capture-rig for activity_log inserts. The real `logActivity` is the
 *  module under test for cron-idle.ts; we mock supabase.from('activity_log')
 *  to record the insert payload without writing to a DB. */
function fakeSupabase(opts: FakeOpts): {
  client: SupabaseClient;
  inserts: Record<string, unknown>[];
} {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => {
      if (table === "activity_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserts.push(row);
            return Promise.resolve({ data: row, error: null });
          },
        };
      }
      if (table === "algorithms") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.algoRow ?? null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    auth: {
      admin: {
        listUsers: () => {
          if (opts.authThrows) return Promise.reject(new Error("admin denied"));
          return Promise.resolve({
            data: { users: opts.authUser ? [opts.authUser] : [] },
          });
        },
      },
    },
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

describe("emitCronIdle", () => {
  it("writes cron_idle row with algorithm_id=null + details.cron='scan'", async () => {
    const { client, inserts } = fakeSupabase({ algoRow: { user_id: "user-1" } });
    const r = await emitCronIdle(client, "scan");
    expect(r).toEqual({ emitted: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      user_id: "user-1",
      algorithm_id: null,
      event_type: "cron_idle",
      ticker: null,
      details: { cron: "scan", active_algos: 0 },
    });
  });

  it("tags manage cron with details.cron='manage'", async () => {
    const { client, inserts } = fakeSupabase({ algoRow: { user_id: "user-1" } });
    await emitCronIdle(client, "manage");
    expect(inserts[0].details).toEqual({ cron: "manage", active_algos: 0 });
  });

  it("prefers an existing algorithm's owner over auth.users", async () => {
    const { client, inserts } = fakeSupabase({
      algoRow: { user_id: "owner-from-algos" },
      authUser: { id: "owner-from-auth" },
    });
    await emitCronIdle(client, "scan");
    expect(inserts[0].user_id).toBe("owner-from-algos");
  });

  it("falls back to auth.users when algorithms table is empty", async () => {
    const { client, inserts } = fakeSupabase({
      algoRow: null,
      authUser: { id: "owner-from-auth" },
    });
    const r = await emitCronIdle(client, "scan");
    expect(r).toEqual({ emitted: true });
    expect(inserts[0].user_id).toBe("owner-from-auth");
  });

  it("returns emitted=false with reason when no user is resolvable", async () => {
    const { client, inserts } = fakeSupabase({ algoRow: null, authUser: null });
    const r = await emitCronIdle(client, "scan");
    expect(r).toEqual({ emitted: false, skipped_reason: "no_user_id_available" });
    expect(inserts).toHaveLength(0);
  });

  it("returns emitted=false when auth.users access throws (admin denied)", async () => {
    const { client, inserts } = fakeSupabase({ algoRow: null, authThrows: true });
    const r = await emitCronIdle(client, "scan");
    expect(r).toEqual({ emitted: false, skipped_reason: "no_user_id_available" });
    expect(inserts).toHaveLength(0);
  });

  it("does NOT consult auth.users when algoRow is present (saves one round-trip)", async () => {
    const listUsers = vi.fn();
    const baseClient = fakeSupabase({ algoRow: { user_id: "owner" } }).client as unknown as {
      auth: { admin: { listUsers: typeof listUsers } };
    };
    baseClient.auth.admin.listUsers = listUsers;
    await emitCronIdle(baseClient as unknown as SupabaseClient, "scan");
    expect(listUsers).not.toHaveBeenCalled();
  });
});
