import { create } from "zustand";
import type { JournalFilters } from "@/types/journal";

interface JournalFilterState {
  filters: JournalFilters;
  page: number;
  setFilter: <K extends keyof JournalFilters>(
    key: K,
    value: JournalFilters[K]
  ) => void;
  resetFilters: () => void;
  setPage: (page: number) => void;
}

export const useJournalFilterStore = create<JournalFilterState>((set) => ({
  filters: {},
  page: 1,
  setFilter: (key, value) =>
    set((state) => {
      const filters = { ...state.filters };
      if (value) { filters[key] = value; } else { delete filters[key]; }
      return { filters, page: 1 };
    }),
  resetFilters: () => set({ filters: {}, page: 1 }),
  setPage: (page) => set({ page }),
}));
