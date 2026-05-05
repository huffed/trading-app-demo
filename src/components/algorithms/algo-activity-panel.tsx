"use client";

/**
 * Algorithm-scoped activity feed — last 20 events for this algorithm,
 * rendered in a glass `Surface` matching the dashboard's
 * `ActivityPanel`. Per-position events live on the position cards;
 * this surface is for algo-level events: scans, halts, errors,
 * divergence, etc.
 */
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  GitCompareArrows,
  LogOut,
  PauseCircle,
  Search,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Surface } from "@/components/ui/surface";
import { useActivityLog } from "@/hooks/use-paper-trading";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants/algorithm";
import { formatRelativeTime } from "@/lib/utils/pnl";
import type { ActivityEventType } from "@/types/activity";

const EVENT_ICONS: Record<ActivityEventType, React.ReactNode> = {
  scan_started: <Search className="h-3.5 w-3.5 text-muted-foreground" />,
  scan_completed: <CheckCircle2 className="h-3.5 w-3.5 text-[var(--profit)]" />,
  signal_detected: <Zap className="h-3.5 w-3.5 text-yellow-500" />,
  signal_no_action: <Search className="h-3.5 w-3.5 text-muted-foreground" />,
  position_opened: <TrendingUp className="h-3.5 w-3.5 text-[var(--profit)]" />,
  position_closed: <LogOut className="h-3.5 w-3.5 text-muted-foreground" />,
  stop_loss_hit: <ShieldAlert className="h-3.5 w-3.5 text-[var(--loss)]" />,
  take_profit_hit: <Target className="h-3.5 w-3.5 text-[var(--profit)]" />,
  error: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
  pair_auto_paused: <PauseCircle className="h-3.5 w-3.5 text-yellow-500" />,
  daily_loss_halt: <ShieldAlert className="h-3.5 w-3.5 text-[var(--loss)]" />,
  portfolio_halt: <ShieldAlert className="h-3.5 w-3.5 text-[var(--loss)]" />,
  drift_halt: <TrendingDown className="h-3.5 w-3.5 text-[var(--loss)]" />,
  divergence_halt: <AlertTriangle className="h-3.5 w-3.5 text-[var(--loss)]" />,
  live_order_placed: <ArrowUpRight className="h-3.5 w-3.5 text-[var(--profit)]" />,
  live_order_failed: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
  live_order_closed: <ArrowDownLeft className="h-3.5 w-3.5 text-muted-foreground" />,
  live_close_failed: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
  scan_overdue: <Clock className="h-3.5 w-3.5 text-yellow-500" />,
  broker_reconciliation_drift: <GitCompareArrows className="h-3.5 w-3.5 text-[var(--loss)]" />,
  manage_tick: <Activity className="h-3.5 w-3.5 text-muted-foreground" />,
};

export function AlgoActivityPanel({ algorithmId }: { algorithmId: string }) {
  const { data, isLoading } = useActivityLog({ algorithm_id: algorithmId }, 1, 20);
  const entries = data?.entries ?? [];

  return (
    <Surface elevation="mid" className="p-5 lg:col-span-5">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Activity log</p>
      </div>
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      )}
      {!isLoading && entries.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No activity yet. Run a scan to populate the feed.
        </p>
      )}
      {!isLoading && entries.length > 0 && (
        <ul className="space-y-2.5">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2.5 text-sm">
              {EVENT_ICONS[entry.event_type] ?? (
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {ACTIVITY_TYPE_LABELS[entry.event_type] ?? entry.event_type}
                {entry.ticker && (
                  <Badge variant="outline" className="ml-1.5 border-glass-border text-xs">
                    {entry.ticker}
                  </Badge>
                )}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatRelativeTime(entry.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

