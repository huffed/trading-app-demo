import { useMutation } from "@tanstack/react-query";
import { runLiveSignal } from "@/app/(dashboard)/algorithms/actions";
import type { SignalResult } from "@/lib/signals/evaluate-live";

export function useLiveSignal() {
  return useMutation({
    mutationFn: async ({ algorithmId, ticker }: { algorithmId: string; ticker: string }) => {
      const result = await runLiveSignal(algorithmId, ticker);
      if (!result.success) { throw new Error(result.error); }
      return result.data as SignalResult;
    },
  });
}
