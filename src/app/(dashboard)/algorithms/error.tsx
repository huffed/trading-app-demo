"use client";

import { RouteError } from "@/components/shared/route-error";

export default function AlgorithmsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} feature="algorithms" />;
}
