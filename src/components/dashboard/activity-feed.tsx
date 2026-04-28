"use client";

import {
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
};

export function ActivityFeed() {
  const { data, isLoading } = useActivityLog({}, 1, 10);
  const entries = data?.entries ?? [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Scan an active algorithm to get started.
          </p>
        ) : (
          <div className="space-y-2.5">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2.5 text-sm">
                {EVENT_ICONS[entry.event_type] ?? (
                  <Search className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0 truncate">
                  <span>{ACTIVITY_TYPE_LABELS[entry.event_type] ?? entry.event_type}</span>
                  {entry.ticker && (
                    <Badge variant="outline" className="ml-1.5 text-xs">
                      {entry.ticker}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatRelativeTime(entry.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
