/**
 * Tabular row primitive — label on the left, monospace value on the
 * right, optional hint under the label. Use inside a `Surface` for
 * dense info panels (e.g. "Entry price · 4523.40", "Side · Long").
 */
import * as React from "react";
import { cn } from "@/lib/utils";

interface DataRowProps {
  label: string;
  value: React.ReactNode;
  /** Subtler text below the label — for context that doesn't deserve its own row. */
  hint?: string;
  className?: string;
}

export function DataRow({ label, value, hint, className }: DataRowProps) {
  return (
    <div
      data-slot="data-row"
      className={cn(
        "flex items-baseline justify-between gap-4 py-2 border-b border-glass-border last:border-b-0",
        className
      )}
    >
      <div className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="font-mono text-sm tabular-nums text-foreground">{value}</div>
    </div>
  );
}
