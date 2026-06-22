/**
 * SG.9 — regression tests for buildBrokerHealthSummary (2026-06-22 NIGHT LATE).
 *
 * Pure-read shared lib backing the /reports Brokers tab. Tests focus
 * on the 5 alert classifiers + composition contracts.
 *
 * Coverage (~17 tests):
 *
 *  Token expiry (3):
 *   - expires within warn window → "expiring_soon" with positive days
 *   - expires in the past → "expired" with negative days
 *   - no token_expires_at → no alert (silent)
 *
 *  Stale sync (3):
 *   - last_synced_at older than threshold → alert
 *   - last_synced_at within threshold → no alert
 *   - last_synced_at null (never synced) → alert with Infinity hours
 *
 *  Last error (2):
 *   - last_error populated → alert with the message text
 *   - last_error empty string or whitespace → no alert
 *
 *  Sibling divergence (3):
 *   - 2+ algos on same broker with same risk % → no alert
 *   - 2+ algos on same broker with DIFFERENT risk % → alert; risk_values sorted asc; sibling_names sorted alpha
 *   - 1 algo on broker (no siblings) → no alert
 *
 *  Snapshot drift (3):
 *   - balance ≥ threshold% from configured → alert
 *   - balance within threshold% → no alert
 *   - no account_snapshot OR no balance field → no alert
 *
 *  Composition + counts (2):
 *   - alert_count = sum of all sections' lengths
 *   - empty broker_connections → all sections empty + zero alert_count + total_connections=0
 *
 *  Error paths (1):
 *   - broker_connections query error → throws loudly
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrokerHealthSummary } from "./broker-health";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FixtureBroker {
  id: string;
  label: string;
  broker_name?: string | null;
  account_capital?: number | string | null;
  token_expires_at?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
  account_snapshot?: { balance?: number } | null;
}

interface FixtureAlgo {
  id: string;
  name: string;
  broker_connection_id: string | null;
  rules: { position_sizing?: { value?: number; type?: string } } | null;
}

function makeSupabaseMock(opts: {
  brokers?: FixtureBroker[];
  brokersError?: { message: string } | null;
  algos?: FixtureAlgo[];
  algosError?: { message: string } | null;
}): SupabaseClient {
  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "broker_connections") {
      const builder: Record<string, unknown> = {};
      builder.order = vi.fn().mockResolvedValue({
        data: opts.brokers ?? [],
        error: opts.brokersError ?? null,
      });
      return { select: vi.fn().mockReturnValue(builder) };
    }
    if (table === "algorithms") {
      // No .order chain here — buildBrokerHealthSummary uses bare select
      return {
        select: vi.fn().mockResolvedValue({
          data: opts.algos ?? [],
          error: opts.algosError ?? null,
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return stub as unknown as SupabaseClient;
}

const NOW = Date.now();
const DAYS_TO_MS = 86_400_000;
const HOURS_TO_MS = 3_600_000;

function inFutureDays(d: number): string {
  return new Date(NOW + d * DAYS_TO_MS).toISOString();
}
function inPastHours(h: number): string {
  return new Date(NOW - h * HOURS_TO_MS).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ======================================================================
// Token expiry
// ======================================================================

describe("buildBrokerHealthSummary — token expiry", () => {
  it("token expiring within warn_days → 'expiring_soon' with positive days_until_expiry", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        { id: "b1", label: "Test", token_expires_at: inFutureDays(3) },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase, { token_warn_days: 7 });
    expect(r.token_expiry).toHaveLength(1);
    expect(r.token_expiry[0]).toMatchObject({
      connection_id: "b1",
      severity: "expiring_soon",
    });
    expect(r.token_expiry[0].days_until_expiry).toBeGreaterThan(2.9);
    expect(r.token_expiry[0].days_until_expiry).toBeLessThan(3.1);
  });

  it("token already expired → 'expired' with negative days_until_expiry", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        { id: "b1", label: "Test", token_expires_at: inFutureDays(-5) },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.token_expiry).toHaveLength(1);
    expect(r.token_expiry[0].severity).toBe("expired");
    expect(r.token_expiry[0].days_until_expiry).toBeLessThan(0);
  });

  it("no token_expires_at → no alert (silent — not all providers populate this field)", async () => {
    const supabase = makeSupabaseMock({
      brokers: [{ id: "b1", label: "Test", token_expires_at: null }],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.token_expiry).toEqual([]);
  });
});

// ======================================================================
// Stale sync
// ======================================================================

describe("buildBrokerHealthSummary — stale sync", () => {
  it("last_synced_at older than threshold_hours → alert", async () => {
    const supabase = makeSupabaseMock({
      brokers: [{ id: "b1", label: "Test", last_synced_at: inPastHours(10) }],
    });
    const r = await buildBrokerHealthSummary(supabase, { stale_sync_threshold_hours: 6 });
    expect(r.stale_sync).toHaveLength(1);
    expect(r.stale_sync[0].hours_since_sync).toBeGreaterThan(9.9);
  });

  it("last_synced_at within threshold → no alert", async () => {
    const supabase = makeSupabaseMock({
      brokers: [{ id: "b1", label: "Test", last_synced_at: inPastHours(3) }],
    });
    const r = await buildBrokerHealthSummary(supabase, { stale_sync_threshold_hours: 6 });
    expect(r.stale_sync).toEqual([]);
  });

  it("last_synced_at null (never synced) → alert with Infinity hours", async () => {
    const supabase = makeSupabaseMock({
      brokers: [{ id: "b1", label: "Test", last_synced_at: null }],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.stale_sync).toHaveLength(1);
    expect(r.stale_sync[0].hours_since_sync).toBe(Number.POSITIVE_INFINITY);
  });
});

// ======================================================================
// Last error
// ======================================================================

describe("buildBrokerHealthSummary — last error", () => {
  it("last_error populated → alert preserves the message text", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        { id: "b1", label: "Test", last_error: "Auth expired: refresh required" },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.last_error).toHaveLength(1);
    expect(r.last_error[0]).toMatchObject({
      connection_id: "b1",
      last_error: "Auth expired: refresh required",
    });
  });

  it("last_error empty string or whitespace → no alert", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        { id: "b1", label: "Empty", last_error: "" },
        { id: "b2", label: "Whitespace", last_error: "   " },
        { id: "b3", label: "Null", last_error: null },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.last_error).toEqual([]);
  });
});

// ======================================================================
// Sibling divergence
// ======================================================================

describe("buildBrokerHealthSummary — sibling risk divergence", () => {
  const brokers: FixtureBroker[] = [
    { id: "b1", label: "Shared" },
    { id: "b2", label: "Solo" },
  ];

  it("2+ algos on same broker with SAME risk % → no alert", async () => {
    const supabase = makeSupabaseMock({
      brokers,
      algos: [
        { id: "a1", name: "Algo One", broker_connection_id: "b1", rules: { position_sizing: { value: 1, type: "risk_per_trade" } } },
        { id: "a2", name: "Algo Two", broker_connection_id: "b1", rules: { position_sizing: { value: 1, type: "risk_per_trade" } } },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.sibling_divergence).toEqual([]);
  });

  it("2+ algos on same broker with DIFFERENT risk % → alert with sorted risk_values + sibling_names", async () => {
    const supabase = makeSupabaseMock({
      brokers,
      algos: [
        { id: "a1", name: "Charlie", broker_connection_id: "b1", rules: { position_sizing: { value: 1.0 } } },
        { id: "a2", name: "Alpha", broker_connection_id: "b1", rules: { position_sizing: { value: 0.6 } } },
        { id: "a3", name: "Bravo", broker_connection_id: "b1", rules: { position_sizing: { value: 1.5 } } },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.sibling_divergence).toHaveLength(1);
    expect(r.sibling_divergence[0].risk_values).toEqual([0.6, 1.0, 1.5]);
    expect(r.sibling_divergence[0].sibling_names).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("1 algo on broker (no siblings) → no alert (can't diverge with self)", async () => {
    const supabase = makeSupabaseMock({
      brokers,
      algos: [{ id: "a1", name: "Solo", broker_connection_id: "b2", rules: { position_sizing: { value: 1 } } }],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.sibling_divergence).toEqual([]);
  });
});

// ======================================================================
// Snapshot drift
// ======================================================================

describe("buildBrokerHealthSummary — snapshot drift", () => {
  it("balance ≥ threshold% from configured → alert with drift_pct", async () => {
    // configured 100k, observed 90k → 10% drift
    const supabase = makeSupabaseMock({
      brokers: [
        {
          id: "b1",
          label: "Test",
          account_capital: 100_000,
          account_snapshot: { balance: 90_000 },
        },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase, { snapshot_drift_threshold_pct: 5 });
    expect(r.snapshot_drift).toHaveLength(1);
    expect(r.snapshot_drift[0].drift_pct).toBeCloseTo(10, 1);
    expect(r.snapshot_drift[0].observed_balance).toBe(90_000);
  });

  it("balance within threshold% → no alert", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        {
          id: "b1",
          label: "Test",
          account_capital: 100_000,
          account_snapshot: { balance: 97_000 }, // 3% drift, under 5% threshold
        },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase, { snapshot_drift_threshold_pct: 5 });
    expect(r.snapshot_drift).toEqual([]);
  });

  it("no account_snapshot OR no balance field → no alert", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        { id: "b1", label: "NoSnap", account_capital: 100_000, account_snapshot: null },
        { id: "b2", label: "EmptySnap", account_capital: 100_000, account_snapshot: {} },
      ],
    });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.snapshot_drift).toEqual([]);
  });
});

// ======================================================================
// Composition + counts
// ======================================================================

describe("buildBrokerHealthSummary — composition + counts", () => {
  it("alert_count = sum of all section lengths", async () => {
    const supabase = makeSupabaseMock({
      brokers: [
        {
          id: "b1",
          label: "All-alerts",
          token_expires_at: inFutureDays(-1), // expired (1)
          last_synced_at: inPastHours(100), // stale (1)
          last_error: "boom", // last_error (1)
          account_capital: 100_000,
          account_snapshot: { balance: 80_000 }, // 20% drift (1)
        },
        { id: "b2", label: "Multi-algo", last_synced_at: inPastHours(1) }, // recent sync, no other issues
      ],
      algos: [
        { id: "a1", name: "X", broker_connection_id: "b2", rules: { position_sizing: { value: 1 } } },
        { id: "a2", name: "Y", broker_connection_id: "b2", rules: { position_sizing: { value: 2 } } },
        // sibling_divergence (1)
      ],
    });
    const r = await buildBrokerHealthSummary(supabase, {
      token_warn_days: 7,
      stale_sync_threshold_hours: 6,
      snapshot_drift_threshold_pct: 5,
    });
    expect(r.alert_count).toBe(
      r.token_expiry.length +
        r.stale_sync.length +
        r.last_error.length +
        r.sibling_divergence.length +
        r.snapshot_drift.length
    );
    expect(r.alert_count).toBe(5); // 1 of each (b1 contributes 4, b2 contributes 1 sibling_divergence)
  });

  it("empty broker_connections → all sections empty + zero alert_count + total_connections=0", async () => {
    const supabase = makeSupabaseMock({ brokers: [], algos: [] });
    const r = await buildBrokerHealthSummary(supabase);
    expect(r.total_connections).toBe(0);
    expect(r.alert_count).toBe(0);
    expect(r.token_expiry).toEqual([]);
    expect(r.stale_sync).toEqual([]);
    expect(r.last_error).toEqual([]);
    expect(r.sibling_divergence).toEqual([]);
    expect(r.snapshot_drift).toEqual([]);
  });
});

// ======================================================================
// Error paths
// ======================================================================

describe("buildBrokerHealthSummary — error paths", () => {
  it("broker_connections query error → throws loudly (not silent empty)", async () => {
    const supabase = makeSupabaseMock({
      brokers: [],
      brokersError: { message: "connection lost" },
    });
    await expect(buildBrokerHealthSummary(supabase)).rejects.toThrow(
      /broker_connections query failed/
    );
  });

  it("algorithms query error → throws loudly", async () => {
    const supabase = makeSupabaseMock({
      brokers: [{ id: "b1", label: "Test" }],
      algos: [],
      algosError: { message: "schema mismatch" },
    });
    await expect(buildBrokerHealthSummary(supabase)).rejects.toThrow(/algorithms query failed/);
  });
});
