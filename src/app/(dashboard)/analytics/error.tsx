"use client";

import { RouteError } from "@/components/shared/route-error";

export default function AnalyticsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} feature="analytics" />;
}
