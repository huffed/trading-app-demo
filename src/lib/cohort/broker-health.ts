/**
 * Broker health summary — operator-facing alert surface for the
 * /reports Brokers tab. SG.9 closure (2026-06-22 NIGHT LATE).
 *
 * PURE READ from `broker_connections` + `algorithms`. Does NOT call live
 * broker APIs from the UI thread (those are expensive + slow + would
 * synchronously block any operator reviewing the page). Live broker
 * health snapshotting is a separate concern that belongs in a cron
 * (filed as SG.9.1 follow-up).
 *
 * 5 alert sections, each surfaces a distinct broker-side risk that
 * the existing crons + dead-man switch + heartbeat DON'T catch:
 *
 *  1. Token-expiry alerts — `token_expires_at` within N days. MetaApi
 *     OAuth tokens expire; an expired token silently produces "broker
 *     unreachable" on every cron tick. Lead-time warning lets operator
 *     re-auth before scan/manage break.
 *  2. Stale-sync alerts — `last_synced_at` older than N hours. Indicates
 *     the broker hasn't been touched recently (no heartbeat, no manage
 *     mirror). Distinct from token expiry — token still valid but no
 *     activity routed through.
 *  3. Last-error alerts — `last_error` field populated. Most recent
 *     broker failure (auth, rate limit, account suspended, etc.).
 *  4. Sibling risk-divergence — multiple algos sharing one broker
 *     connection with DIFFERENT `position_sizing.value` (risk %).
 *     Operator-error class: typically all siblings should match risk %
 *     for combined-DLL math to be predictable; divergence means
 *     risk-pool gate's headroom is opaque.
 *  5. Snapshot drift — `account_snapshot.balance` (if present) differs
 *     from configured `account_capital` (challenge start). Indicates
 *     the broker reports a different account size than the challenge
 *     reference — could be a challenge transition (account paid out
 *     to next tier) or a sync bug.
 *
 * Empty data graceful return: zero broker connections → empty arrays
 * + zero alert counts. Operator reads "no alerts — no broker
 * connections" cleanly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TokenExpiryAlert {
  connection_id: string;
  label: string;
  broker_name: string | null;
  token_expires_at: string;
  days_until_expiry: number;
  /** "expired" if days_until_expiry < 0, "expiring_soon" otherwise. */
  severity: "expired" | "expiring_soon";
}

export interface StaleSyncAlert {
  connection_id: string;
  label: string;
  broker_name: string | null;
  last_synced_at: string | null;
  hours_since_sync: number;
}

export interface LastErrorAlert {
  connection_id: string;
  label: string;
  broker_name: string | null;
  last_error: string;
  last_synced_at: string | null;
}

export interface SiblingDivergenceAlert {
  connection_id: string;
  label: string;
  broker_name: string | null;
  /** Distinct risk-pct values seen across siblings on this broker. */
  risk_values: number[];
  /** Sibling algo names (so operator can see WHICH algos diverge). */
  sibling_names: string[];
}

export interface SnapshotDriftAlert {
  connection_id: string;
  label: string;
  broker_name: string | null;
  configured_capital: number;
  observed_balance: number;
  drift_pct: number;
}

export interface BrokerHealthSummary {
  generated_at: string;
  /** N-day window for stale-sync threshold. */
  stale_sync_threshold_hours: number;
  /** N-day window for token-expiry alerts. */
  token_warn_days: number;
  /** Snapshot drift threshold (percentage points). */
  snapshot_drift_threshold_pct: number;
  /** Total broker connections evaluated. */
  total_connections: number;
  token_expiry: TokenExpiryAlert[];
  stale_sync: StaleSyncAlert[];
  last_error: LastErrorAlert[];
  sibling_divergence: SiblingDivergenceAlert[];
  snapshot_drift: SnapshotDriftAlert[];
  alert_count: number;
}

export interface BrokerHealthOptions {
  /** Stale-sync threshold in hours. Default 6 (matches typical cron cadence). */
  stale_sync_threshold_hours?: number;
  /** Token expiry warn-window in days. Default 7. */
  token_warn_days?: number;
  /** Snapshot drift threshold (percentage points). Default 5. */
  snapshot_drift_threshold_pct?: number;
}

interface ConnectionRow {
  id: string;
  label: string;
  broker_name: string | null;
  account_capital: string | number | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  account_snapshot: { balance?: number; equity?: number } | null;
}

interface AlgoRow {
  id: string;
  name: string;
  broker_connection_id: string | null;
  rules: { position_sizing?: { value?: number; type?: string } } | null;
}

const HOURS_TO_MS = 3_600_000;
const DAYS_TO_MS = 86_400_000;

function detectTokenExpiry(
  rows: ConnectionRow[],
  now: Date,
  warnDays: number
): TokenExpiryAlert[] {
  const out: TokenExpiryAlert[] = [];
  const warnMs = warnDays * DAYS_TO_MS;
  for (const r of rows) {
    if (!r.token_expires_at) continue;
    const expiresMs = new Date(r.token_expires_at).getTime();
    if (Number.isNaN(expiresMs)) continue;
    const deltaMs = expiresMs - now.getTime();
    const days = deltaMs / DAYS_TO_MS;
    if (deltaMs < 0) {
      out.push({
        connection_id: r.id,
        label: r.label,
        broker_name: r.broker_name,
        token_expires_at: r.token_expires_at,
        days_until_expiry: days,
        severity: "expired",
      });
    } else if (deltaMs < warnMs) {
      out.push({
        connection_id: r.id,
        label: r.label,
        broker_name: r.broker_name,
        token_expires_at: r.token_expires_at,
        days_until_expiry: days,
        severity: "expiring_soon",
      });
    }
  }
  return out;
}

function detectStaleSync(
  rows: ConnectionRow[],
  now: Date,
  thresholdHours: number
): StaleSyncAlert[] {
  const out: StaleSyncAlert[] = [];
  const thresholdMs = thresholdHours * HOURS_TO_MS;
  for (const r of rows) {
    if (!r.last_synced_at) {
      // Never-synced is also stale. Report as "never" indirectly via large hours value.
      out.push({
        connection_id: r.id,
        label: r.label,
        broker_name: r.broker_name,
        last_synced_at: null,
        hours_since_sync: Number.POSITIVE_INFINITY,
      });
      continue;
    }
    const syncedMs = new Date(r.last_synced_at).getTime();
    if (Number.isNaN(syncedMs)) continue;
    const ageMs = now.getTime() - syncedMs;
    if (ageMs >= thresholdMs) {
      out.push({
        connection_id: r.id,
        label: r.label,
        broker_name: r.broker_name,
        last_synced_at: r.last_synced_at,
        hours_since_sync: ageMs / HOURS_TO_MS,
      });
    }
  }
  return out;
}

function detectLastError(rows: ConnectionRow[]): LastErrorAlert[] {
  return rows
    .filter((r) => r.last_error && r.last_error.trim() !== "")
    .map((r) => ({
      connection_id: r.id,
      label: r.label,
      broker_name: r.broker_name,
      last_error: r.last_error!,
      last_synced_at: r.last_synced_at,
    }));
}

function detectSiblingDivergence(
  brokers: ConnectionRow[],
  algos: AlgoRow[]
): SiblingDivergenceAlert[] {
  const out: SiblingDivergenceAlert[] = [];
  const byBroker = new Map<string, AlgoRow[]>();
  for (const a of algos) {
    if (!a.broker_connection_id) continue;
    const list = byBroker.get(a.broker_connection_id) ?? [];
    list.push(a);
    byBroker.set(a.broker_connection_id, list);
  }
  for (const broker of brokers) {
    const siblings = byBroker.get(broker.id) ?? [];
    if (siblings.length < 2) continue; // single-algo broker can't diverge
    const riskValues = new Set<number>();
    for (const s of siblings) {
      const v = s.rules?.position_sizing?.value;
      if (typeof v === "number") riskValues.add(v);
    }
    if (riskValues.size >= 2) {
      out.push({
        connection_id: broker.id,
        label: broker.label,
        broker_name: broker.broker_name,
        risk_values: [...riskValues].sort((a, b) => a - b),
        sibling_names: siblings.map((s) => s.name).sort(),
      });
    }
  }
  return out;
}

function detectSnapshotDrift(
  rows: ConnectionRow[],
  thresholdPct: number
): SnapshotDriftAlert[] {
  const out: SnapshotDriftAlert[] = [];
  for (const r of rows) {
    const configured = typeof r.account_capital === "string" ? Number(r.account_capital) : r.account_capital;
    if (configured == null || configured <= 0) continue;
    const balance = r.account_snapshot?.balance;
    if (typeof balance !== "number" || balance <= 0) continue;
    const driftPct = Math.abs((balance - configured) / configured) * 100;
    if (driftPct >= thresholdPct) {
      out.push({
        connection_id: r.id,
        label: r.label,
        broker_name: r.broker_name,
        configured_capital: configured,
        observed_balance: balance,
        drift_pct: driftPct,
      });
    }
  }
  return out;
}

/**
 * Build the broker health summary from existing DB sources. Always
 * returns a valid summary — zero connections → empty arrays. Errors
 * throw loudly (not silent empty).
 */
export async function buildBrokerHealthSummary(
  supabase: SupabaseClient,
  opts: BrokerHealthOptions = {}
): Promise<BrokerHealthSummary> {
  const stale_sync_threshold_hours = opts.stale_sync_threshold_hours ?? 6;
  const token_warn_days = opts.token_warn_days ?? 7;
  const snapshot_drift_threshold_pct = opts.snapshot_drift_threshold_pct ?? 5;
  const generated_at = new Date().toISOString();
  const now = new Date();

  const { data: brokers, error: brokersErr } = await supabase
    .from("broker_connections")
    .select(
      "id, label, broker_name, account_capital, token_expires_at, last_synced_at, last_error, account_snapshot"
    )
    .order("label");
  if (brokersErr) throw new Error(`broker_connections query failed: ${brokersErr.message}`);
  const brokerRows = (brokers ?? []) as ConnectionRow[];

  const { data: algos, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, broker_connection_id, rules");
  if (algoErr) throw new Error(`algorithms query failed: ${algoErr.message}`);
  const algoRows = (algos ?? []) as AlgoRow[];

  const token_expiry = detectTokenExpiry(brokerRows, now, token_warn_days);
  const stale_sync = detectStaleSync(brokerRows, now, stale_sync_threshold_hours);
  const last_error = detectLastError(brokerRows);
  const sibling_divergence = detectSiblingDivergence(brokerRows, algoRows);
  const snapshot_drift = detectSnapshotDrift(brokerRows, snapshot_drift_threshold_pct);

  const alert_count =
    token_expiry.length +
    stale_sync.length +
    last_error.length +
    sibling_divergence.length +
    snapshot_drift.length;

  return {
    generated_at,
    stale_sync_threshold_hours,
    token_warn_days,
    snapshot_drift_threshold_pct,
    total_connections: brokerRows.length,
    token_expiry,
    stale_sync,
    last_error,
    sibling_divergence,
    snapshot_drift,
    alert_count,
  };
}
