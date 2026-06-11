"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fromJson } from "@/lib/supabase/row-mappers";
import type { TradingProfile } from "@/types/trading-profile";

const PROFILE_KEY = ["trading-profile"];

export function useTradingProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("profiles")
        .select("trading_profile")
        .eq("id", user.id)
        .single();
      if (error) throw error;
      return fromJson<TradingProfile | null>(data?.trading_profile ?? null) ?? null;
    },
  });
}
