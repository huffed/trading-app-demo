"use client";

import { RouteError } from "@/components/shared/route-error";

export default function PortfoliosError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} feature="portfolios" />;
}
