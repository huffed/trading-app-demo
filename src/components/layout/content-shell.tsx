/**
 * In-page content shell for the redesigned UI. The `(dashboard)` layout
 * already provides the sidebar + topbar; this lives INSIDE that and
 * gives pages an optional inspector rail (right column) for contextual
 * details — selected algorithm metadata, position detail, etc.
 *
 * Without an inspector this is just a max-width container with
 * consistent padding. With one, the rail collapses gracefully on
 * narrow viewports (stacks below).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

interface ContentShellProps {
  children: React.ReactNode;
  inspector?: React.ReactNode;
  className?: string;
}

export function ContentShell({ children, inspector, className }: ContentShellProps) {
  if (!inspector) {
    return <div className={cn("mx-auto max-w-7xl px-6 py-6", className)}>{children}</div>;
  }
  return (
    <div className={cn("mx-auto max-w-7xl px-6 py-6", className)}>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <main className="min-w-0">{children}</main>
        <aside className="lg:border-l lg:border-glass-border lg:pl-6">{inspector}</aside>
      </div>
    </div>
  );
}
