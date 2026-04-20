"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  analyzeJournalEntryAction,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
} from "@/app/(dashboard)/journal/actions";
import { createClient } from "@/lib/supabase/client";
import type { JournalFormValues } from "@/lib/validators/journal";
import type { JournalEntry, JournalFilters } from "@/types/journal";

const JOURNAL_KEY = ["journal"];

export function useJournalEntries(
  filters: JournalFilters = {},
  page = 1,
  perPage = 12
) {
  return useQuery({
    queryKey: [...JOURNAL_KEY, filters, page, perPage],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("journal_entries")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (filters.emotion) query = query.eq("emotion", filters.emotion);
      if (filters.entry_type)
        {query = query.eq("entry_type", filters.entry_type);}
      if (filters.date_from)
        {query = query.gte("created_at", filters.date_from);}
      if (filters.date_to)
        {query = query.lte("created_at", filters.date_to);}
      if (filters.search)
        {query = query.or(
          `title.ilike.%${filters.search}%,content.ilike.%${filters.search}%`
        );}

      const from = (page - 1) * perPage;
      const to = from + perPage - 1;
      query = query.range(from, to);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        entries: (data ?? []) as JournalEntry[],
        total: count ?? 0,
        page,
        perPage,
      };
    },
  });
}

export function useJournalEntry(id: string | null) {
  return useQuery({
    queryKey: [...JOURNAL_KEY, id],
    enabled: !!id,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as JournalEntry;
    },
  });
}

export function useCreateJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: JournalFormValues) => createJournalEntry(values),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      }
    },
  });
}

export function useUpdateJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      values,
    }: {
      id: string;
      values: Partial<JournalFormValues>;
    }) => updateJournalEntry(id, values),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      }
    },
  });
}

export function useDeleteJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteJournalEntry(id),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      }
    },
  });
}

export function useAnalyzeJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => analyzeJournalEntryAction(entryId),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      }
    },
  });
}

export function useTradesForLinking(search?: string) {
  return useQuery({
    queryKey: ["trades-for-linking", search],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("trades")
        .select("id, symbol, side, entry_date, realized_pnl")
        .order("entry_date", { ascending: false })
        .limit(20);

      if (search) {
        query = query.ilike("symbol", `%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}
