/**
 * 12-column responsive grid for dashboard composition. Each child sets
 * its own `col-span` (use `colSpan` slot prop or just `className`).
 * Collapses to 1-col on mobile.
 *
 * Use for the body of a dashboard once the KPI strip is laid out — for
 * mixing wide chart cards (col-span-8) with narrow status cards
 * (col-span-4), etc.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

interface DashboardGridProps {
  children: React.ReactNode;
  className?: string;
}

export function DashboardGrid({ children, className }: DashboardGridProps) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-12", className)}>{children}</div>
  );
}
