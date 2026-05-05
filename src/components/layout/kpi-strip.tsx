/**
 * Horizontal row of KPI cells. Wraps each cell in a `Surface` so the
 * strip reads as a row of glass tiles. Responsive: 4 across desktop,
 * 2 on mobile, 1 on the smallest viewport.
 *
 * Pass `Stat` children:
 *   <KpiStrip>
 *     <Stat label="Today" value="+$1,240" state="profit" />
 *     <Stat label="Open" value="3" />
 *     ...
 *   </KpiStrip>
 */
import * as React from "react";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

interface KpiStripProps {
  children: React.ReactNode;
  className?: string;
}

export function KpiStrip({ children, className }: KpiStripProps) {
  const cells = React.Children.toArray(children);
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {cells.map((cell, i) => (
        <Surface key={i} elevation="mid" className="p-4">
          {cell}
        </Surface>
      ))}
    </div>
  );
}
