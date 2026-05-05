/**
 * Glass-surface primitive — the panel building block for the redesigned
 * UI. Wraps content in a translucent, blurred panel with a tinted edge
 * highlight. Replaces ad-hoc `<Card>`-with-custom-classes patterns.
 *
 * Use `elevation` to indicate depth in the layout: `low` for sidebars
 * and secondary panes, `mid` for primary cards, `high` for modals and
 * popovers, `sunken` for inputs / depressed regions (no blur, opaque).
 *
 * `interactive` adds a hover transition that lifts the border to its
 * `-strong` variant — for clickable cards. Not for static panels.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

type Elevation = "low" | "mid" | "high" | "sunken";

interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  elevation?: Elevation;
  /** Apply backdrop-blur. Default true; set false for opaque sub-panels. */
  blur?: boolean;
  /** Hover lift. Set true for clickable cards. */
  interactive?: boolean;
}

const ELEVATION_CLASSES: Record<Elevation, string> = {
  low: "bg-surface-low border-glass-border shadow-glass-sm",
  mid: "bg-surface-mid border-glass-border shadow-glass-md",
  high: "bg-surface-high border-glass-border-strong shadow-glass-lg",
  sunken: "bg-surface-sunken border-glass-border",
};

export function Surface({
  className,
  elevation = "mid",
  blur = true,
  interactive = false,
  children,
  ...props
}: SurfaceProps) {
  return (
    <div
      data-slot="surface"
      data-elevation={elevation}
      className={cn(
        "rounded-xl border",
        ELEVATION_CLASSES[elevation],
        blur && elevation !== "sunken" && "backdrop-blur-xl",
        interactive &&
          "transition-colors duration-200 ease-[var(--ease-glass)] hover:border-glass-border-strong",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
