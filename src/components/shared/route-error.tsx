"use client";

import { useEffect } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Short label of the failing feature — surfaced in the message and used
   *  as the logger scope. */
  feature: string;
}

/** Per-route error boundary fallback. Renders inside the dashboard shell
 *  so the sidebar/topbar stay intact when a feature throws — only the
 *  affected page content swaps to this card. */
export function RouteError({ error, reset, feature }: RouteErrorProps) {
  useEffect(() => {
    logger.error(feature, "Unhandled route error", error);
  }, [error, feature]);

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <TriangleAlertIcon className="h-8 w-8 text-muted-foreground mb-3" />
      <h2 className="text-base font-semibold">Couldn’t load {feature}</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        Something went wrong rendering this page. The rest of the app is
        unaffected.
      </p>
      <Button className="mt-4" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
