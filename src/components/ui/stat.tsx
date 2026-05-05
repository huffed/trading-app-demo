/**
 * KPI cell — label + value + optional delta + state tint. Tabular
 * numerics so values align across a `KpiStrip`. State drives color:
 * `profit`/`loss` for P&L, `warn` for at-risk metrics, `neutral`
 * otherwise.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

type State = "neutral" | "profit" | "loss" | "warn";

interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Optional delta line below the value (e.g. "+1.2% today", "8 trades"). */
  delta?: React.ReactNode;
  state?: State;
  className?: string;
}

const STATE_CLASSES: Record<State, string> = {
  neutral: "text-foreground",
  profit: "text-[var(--profit)]",
  loss: "text-[var(--loss)]",
  warn: "text-amber-400",
};

export function Stat({ label, value, delta, state = "neutral", className }: StatProps) {
  return (
    <div data-slot="stat" data-state={state} className={cn("flex flex-col gap-1", className)}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-2xl font-semibold tabular-nums", STATE_CLASSES[state])}>
        {value}
      </p>
      {delta && (
        <p className="font-mono text-xs tabular-nums text-muted-foreground">{delta}</p>
      )}
    </div>
  );
}
