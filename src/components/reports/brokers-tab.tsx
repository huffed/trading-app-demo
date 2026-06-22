"use client";

import {
  AlertCircle,
  AlertTriangle,
  Clock,
  KeyRound,
  ShieldAlert,
  Split,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBrokerHealth } from "@/hooks/use-broker-health";
import type {
  LastErrorAlert,
  SiblingDivergenceAlert,
  SnapshotDriftAlert,
  StaleSyncAlert,
  TokenExpiryAlert,
} from "@/lib/cohort/broker-health";

/**
 * Brokers tab — SG.9 closure (2026-06-22 NIGHT LATE).
 *
 * Pure-read alert surface over `broker_connections` + `algorithms`.
 * Does NOT call live broker APIs (would be expensive + slow on every
 * page render). Live broker health snapshotting is filed as
 * SG.9.1 (cron job — separate concern).
 *
 * 5 alert sections, each surfacing a distinct broker-side risk the
 * existing crons + dead-man switch + heartbeat DON'T catch:
 *
 *   1. Token expiry — re-auth before scan/manage break
 *   2. Stale sync — broker hasn't been touched in N hours
 *   3. Last error — recent broker call failure recorded on the row
 *   4. Sibling risk divergence — algos sharing a broker with different risk %
 *   5. Snapshot drift — broker-reported balance vs configured capital
 *
 * Honest scope-fence: an EMPTY alert page does NOT mean "broker is
 * definitely healthy" — it means none of these 5 conditions are tripped
 * in the DB. The truly-live check (broker API responsive right now)
 * requires SG.9.1 cron snapshotting.
 */
export function BrokersTab() {
  const { data, isLoading, isError, error } = useBrokerHealth();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Broker connection health alerts from <code>broker_connections</code> +{" "}
        <code>algorithms</code>. <strong>Pure read from DB</strong> — does not call live broker
        APIs (cost / latency). Live broker-reachability is checked by the existing dead-man
        switch + heartbeat cron; THIS surface catches the alert classes those don&apos;t (token
        expiry, sibling risk divergence, snapshot drift). An empty page means none of these
        conditions are tripped in DB; it does NOT prove the broker API is up right now.
      </p>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load broker health</p>
              <p className="text-muted-foreground mt-1">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          <SummaryRow
            total_connections={data.total_connections}
            alert_count={data.alert_count}
            token_expiry={data.token_expiry.length}
            stale_sync={data.stale_sync.length}
            last_error={data.last_error.length}
            sibling_divergence={data.sibling_divergence.length}
            snapshot_drift={data.snapshot_drift.length}
          />
          {data.total_connections === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                No broker connections configured yet. Add one via Settings → Brokers.
              </CardContent>
            </Card>
          ) : (
            <>
              <TokenExpiryCard
                alerts={data.token_expiry}
                warn_days={data.token_warn_days}
              />
              <StaleSyncCard
                alerts={data.stale_sync}
                threshold_hours={data.stale_sync_threshold_hours}
              />
              <LastErrorCard alerts={data.last_error} />
              <SiblingDivergenceCard alerts={data.sibling_divergence} />
              <SnapshotDriftCard
                alerts={data.snapshot_drift}
                threshold_pct={data.snapshot_drift_threshold_pct}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SummaryRow(props: {
  total_connections: number;
  alert_count: number;
  token_expiry: number;
  stale_sync: number;
  last_error: number;
  sibling_divergence: number;
  snapshot_drift: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryCard label="Connections" value={props.total_connections.toString()} icon={<Wallet className="h-4 w-4" />} />
      <SummaryCard
        label="Total alerts"
        value={props.alert_count.toString()}
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
        accent={props.alert_count > 0 ? "text-amber-500" : "text-emerald-500"}
      />
      <SummaryCard label="Token expiry" value={props.token_expiry.toString()} icon={<KeyRound className="h-4 w-4" />} />
      <SummaryCard label="Stale sync" value={props.stale_sync.toString()} icon={<Clock className="h-4 w-4" />} />
      <SummaryCard label="Sibling risk divergence" value={props.sibling_divergence.toString()} icon={<Split className="h-4 w-4" />} />
      <SummaryCard label="Snapshot drift" value={props.snapshot_drift.toString()} icon={<ShieldAlert className="h-4 w-4" />} />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold tabular-nums ${accent ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

/** Shared section frame for all 5 alert cards — header (icon + title + count
 *  badge) + empty-state vs populated body. Reduces 5 near-duplicate card
 *  components to single-responsibility children. */
function AlertSection({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          {icon}
          {title}
          <Badge variant="outline" className="ml-auto">{count}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : children}
      </CardContent>
    </Card>
  );
}

function BrokerLabelInline({ label, broker_name }: { label: string; broker_name: string | null }) {
  return (
    <>
      <span className="font-medium">{label}</span>
      {broker_name && <span className="text-muted-foreground text-xs">({broker_name})</span>}
    </>
  );
}

function TokenExpiryCard({ alerts, warn_days }: { alerts: TokenExpiryAlert[]; warn_days: number }) {
  return (
    <AlertSection
      icon={<KeyRound className="h-4 w-4" />}
      title="Token expiry"
      count={alerts.length}
      empty={<>No tokens expiring within {warn_days}d (or no <code>token_expires_at</code> populated on any connection).</>}
    >
      <ul className="space-y-1.5 text-sm">
        {alerts.map((a) => (
          <li key={a.connection_id} className="flex items-center gap-3">
            <Badge variant={a.severity === "expired" ? "destructive" : "outline"}>
              {a.severity === "expired" ? "EXPIRED" : "soon"}
            </Badge>
            <BrokerLabelInline label={a.label} broker_name={a.broker_name} />
            <span className="text-muted-foreground tabular-nums ml-auto">
              {a.severity === "expired"
                ? `${Math.abs(Math.round(a.days_until_expiry))}d ago`
                : `in ${Math.round(a.days_until_expiry)}d`}
            </span>
          </li>
        ))}
      </ul>
    </AlertSection>
  );
}

function StaleSyncCard({ alerts, threshold_hours }: { alerts: StaleSyncAlert[]; threshold_hours: number }) {
  return (
    <AlertSection
      icon={<Clock className="h-4 w-4" />}
      title="Stale sync"
      count={alerts.length}
      empty={<>All connections synced within {threshold_hours}h.</>}
    >
      <ul className="space-y-1.5 text-sm">
        {alerts.map((a) => (
          <li key={a.connection_id} className="flex items-center gap-3">
            <BrokerLabelInline label={a.label} broker_name={a.broker_name} />
            <span className="text-muted-foreground tabular-nums ml-auto">
              {Number.isFinite(a.hours_since_sync) ? `${a.hours_since_sync.toFixed(1)}h ago` : "never synced"}
            </span>
          </li>
        ))}
      </ul>
    </AlertSection>
  );
}

function LastErrorCard({ alerts }: { alerts: LastErrorAlert[] }) {
  return (
    <AlertSection
      icon={<AlertCircle className="h-4 w-4 text-destructive" />}
      title="Last broker error"
      count={alerts.length}
      empty={<>No <code>last_error</code> recorded on any broker connection.</>}
    >
      <ul className="space-y-2 text-sm">
        {alerts.map((a) => (
          <li key={a.connection_id} className="border-l-2 border-destructive pl-3">
            <div className="flex items-center gap-2">
              <BrokerLabelInline label={a.label} broker_name={a.broker_name} />
            </div>
            <p className="text-muted-foreground text-xs mt-0.5 font-mono">{a.last_error}</p>
          </li>
        ))}
      </ul>
    </AlertSection>
  );
}

function SiblingDivergenceCard({ alerts }: { alerts: SiblingDivergenceAlert[] }) {
  return (
    <AlertSection
      icon={<Split className="h-4 w-4" />}
      title="Sibling risk divergence"
      count={alerts.length}
      empty={<>All multi-algo brokers have uniform risk %. (Single-algo brokers can&apos;t diverge.)</>}
    >
      <ul className="space-y-3 text-sm">
        {alerts.map((a) => (
          <li key={a.connection_id} className="border-l-2 border-amber-500 pl-3">
            <div className="flex items-center gap-2">
              <BrokerLabelInline label={a.label} broker_name={a.broker_name} />
              <span className="text-muted-foreground tabular-nums ml-auto">
                risk: {a.risk_values.join(" / ")}%
              </span>
            </div>
            <p className="text-muted-foreground text-xs mt-1">Siblings: {a.sibling_names.join(", ")}</p>
          </li>
        ))}
      </ul>
    </AlertSection>
  );
}

function SnapshotDriftCard({ alerts, threshold_pct }: { alerts: SnapshotDriftAlert[]; threshold_pct: number }) {
  return (
    <AlertSection
      icon={<ShieldAlert className="h-4 w-4" />}
      title="Snapshot drift"
      count={alerts.length}
      empty={
        <>
          No broker reports balance drifting ≥{threshold_pct}% from configured{" "}
          <code>account_capital</code> (or no <code>account_snapshot.balance</code> recorded).
        </>
      }
    >
      <ul className="space-y-1.5 text-sm">
        {alerts.map((a) => (
          <li key={a.connection_id} className="flex items-center gap-3">
            <BrokerLabelInline label={a.label} broker_name={a.broker_name} />
            <span className="text-muted-foreground tabular-nums ml-auto">
              configured ${a.configured_capital.toLocaleString()} · observed ${a.observed_balance.toLocaleString()} · drift {a.drift_pct.toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </AlertSection>
  );
}
