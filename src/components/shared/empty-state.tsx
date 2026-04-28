import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateAction {
  href: string;
  label: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
}

interface EmptyStateProps {
  /** Optional icon rendered above the title (use a lucide-react icon at h-8 w-8). */
  icon?: ReactNode;
  /** Primary line — describes what's missing. */
  title: string;
  /** Optional sub-line — what the user should do next. */
  description?: string;
  /** Optional CTA — typically a link to the create/import flow. */
  action?: EmptyStateAction;
  /** Override the default vertical padding (e.g. "py-8" for tighter contexts). */
  className?: string;
}

/** Centered "nothing here yet" placeholder with optional icon + CTA. Use
 *  this anywhere a feature has zero rows to render. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-center",
        className
      )}
    >
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>
      )}
      {action && (
        <Button
          className="mt-4"
          size="sm"
          variant={action.variant}
          render={<Link href={action.href} />}
          nativeButton={false}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
