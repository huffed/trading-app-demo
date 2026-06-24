"use client";

import { useQuery } from "@tanstack/react-query";
import { getRobustnessAuditsAction } from "@/app/(dashboard)/reports/actions";

/**
 * F2 search-robustness audit results loaded from disk
 * (scripts/canonical/robustness-audit-*.json).
 *
 * 60-second staleTime — audits are written by manual operator-triggered
 * driver runs, never on a cadence; faster polling would burn bandwidth.
 */
export function useRobustnessAudits() {
  return useQuery({
    queryKey: ["robustness-audits"],
    staleTime: 60_000,
    queryFn: async () => {
      const result = await getRobustnessAuditsAction();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
