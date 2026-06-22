"use client";

import { useState } from "react";
import { Activity, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  useDeleteBrokerConnection,
  useSyncBrokerConnection,
} from "@/hooks/use-broker-connections";
import { BROKER_STATUS_LABELS } from "@/lib/constants/algorithm";
import type { BrokerAccountSnapshot, BrokerConnectionView } from "@/types/broker";

const STATUS_VARIANT: Record<BrokerConnectionView["status"], "default" | "secondary" | "outline"> = {
  active: "default",
  pending: "secondary",
  error: "secondary",
  disabled: "outline",
};

function fmtMoney(n: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

function SnapshotStats({ snap }: { snap: BrokerAccountSnapshot }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div>
        <p className="text-xs text-muted-foreground">Balance</p>
        <p className="text-sm font-medium tabular-nums">
          {fmtMoney(snap.balance, snap.currency)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Equity</p>
        <p className="text-sm font-medium tabular-nums">
          {fmtMoney(snap.equity, snap.currency)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Free Margin</p>
        <p className="text-sm font-medium tabular-nums">
          {snap.free_margin != null ? fmtMoney(snap.free_margin, snap.currency) : "—"}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Open Positions</p>
        <p className="text-sm font-medium tabular-nums">{snap.position_count}</p>
      </div>
    </div>
  );
}

function PositionsList({ snap }: { snap: BrokerAccountSnapshot }) {
  if (snap.positions.length === 0) {
    return <p className="text-xs text-muted-foreground">No open positions.</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Open positions
      </p>
      <div className="divide-y rounded-md border">
        {snap.positions.map((p) => (
          <div key={p.id} className="flex items-center justify-between p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium">{p.symbol}</span>
              <Badge variant={p.side === "buy" ? "default" : "secondary"} className="text-[10px]">
                {p.side.toUpperCase()} {p.volume}
              </Badge>
            </div>
            <span
              className={`tabular-nums font-medium ${
                p.profit >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
              }`}
            >
              {p.profit >= 0 ? "+" : ""}
              {fmtMoney(p.profit, snap.currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardHeaderRow({
  conn,
  pending,
  onSync,
  onToggleConfirm,
}: {
  conn: BrokerConnectionView;
  pending: boolean;
  onSync: () => void;
  onToggleConfirm: () => void;
}) {
  return (
    <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
      <div className="space-y-0.5">
        <CardTitle className="text-sm font-medium">{conn.label}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {conn.broker_name || conn.provider.toUpperCase()}
          {conn.server ? ` · ${conn.server}` : ""}
          {conn.account_login ? ` · #${conn.account_login}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Badge variant={STATUS_VARIANT[conn.status]} className="text-[10px]">
          {BROKER_STATUS_LABELS[conn.status] ?? conn.status}
        </Badge>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onSync}
          disabled={pending}
          title="Refresh from broker"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleConfirm}
          disabled={pending}
          title="Delete connection"
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
    </CardHeader>
  );
}

function ConfirmDelete({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 flex items-center justify-between text-xs">
      <span>Delete this connection? It won&apos;t affect the broker account itself.</span>
      <div className="flex gap-1">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="destructive" onClick={onConfirm} disabled={pending}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export function BrokerCard({ conn }: { conn: BrokerConnectionView }) {
  const [error, setError] = useState<string | null>(conn.last_error);
  const [isConfirming, setIsConfirming] = useState(false);
  const sync = useSyncBrokerConnection();
  const del = useDeleteBrokerConnection();
  const pending = sync.isPending || del.isPending;

  function handleSync() {
    setError(null);
    sync.mutate(conn.id, {
      onSuccess: (r) => {
        if (!r.success) setError(r.error);
      },
      onError: () => setError("Sync failed."),
    });
  }

  function handleDelete() {
    del.mutate(conn.id, {
      onSuccess: (r) => {
        if (!r.success) setError(r.error);
      },
      onError: () => setError("Delete failed."),
    });
  }

  const snap = conn.account_snapshot;
  const lastSync = conn.last_synced_at
    ? new Date(conn.last_synced_at).toLocaleString()
    : "Never";

  return (
    <Card>
      <CardHeaderRow
        conn={conn}
        pending={pending}
        onSync={handleSync}
        onToggleConfirm={() => setIsConfirming((v) => !v)}
      />
      <CardContent className="space-y-3">
        {isConfirming && (
          <ConfirmDelete
            pending={pending}
            onCancel={() => setIsConfirming(false)}
            onConfirm={handleDelete}
          />
        )}
        {error && (
          <p className="text-xs text-[var(--loss)] flex items-start gap-1.5">
            <Activity className="mt-0.5 h-3 w-3 shrink-0" />
            {error}
          </p>
        )}
        {snap ? (
          <>
            <SnapshotStats snap={snap} />
            <Separator />
            <PositionsList snap={snap} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No snapshot yet — click the refresh icon to test the connection.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">Last synced: {lastSync}</p>
      </CardContent>
    </Card>
  );
}
