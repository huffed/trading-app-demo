"use client";

import { useState } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

/** Server actions in this codebase return ActionResult<T> rather than throw,
 *  so a "successful" mutation can still represent a failure. Detect the
 *  failure shape so we can surface it to the user. */
type ActionFailure = { success: false; error: string };
function isActionFailure(value: unknown): value is ActionFailure {
  return (
    !!value &&
    typeof value === "object" &&
    "success" in value &&
    (value as { success: unknown }).success === false &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Surface mutation failures to the user. Two paths:
        //  - mutationFn throws → onError fires (no toast if hook handles it)
        //  - mutationFn returns ActionResult { success: false } → onSuccess
        //    fires with the failure-shaped payload; we toast it. Per-mutation
        //    onSuccess still runs (TanStack Query calls cache callbacks in
        //    addition to mutation callbacks) so hooks keep their invalidation
        //    logic without re-implementing the failure toast.
        mutationCache: new MutationCache({
          onSuccess: (data) => {
            if (isActionFailure(data)) toast.error(data.error);
          },
          onError: (error, _vars, _ctx, mutation) => {
            if (mutation.options.onError) return;
            toast.error(extractErrorMessage(error));
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
