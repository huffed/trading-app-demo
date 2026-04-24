import { create } from "zustand";
import type { TradeFilters } from "@/types/trade";

interface TradeFilterState {
  filters: TradeFilters;
  page: number;
  setFilter: <K extends keyof TradeFilters>(key: K, value: TradeFilters[K]) => void;
  resetFilters: () => void;
  setPage: (page: number) => void;
}

export const useTradeFilterStore = create<TradeFilterState>((set) => ({
  filters: {},
  page: 1,
  setFilter: (key, value) =>
    set((state) => {
      const filters = { ...state.filters };
      if (value) {
        filters[key] = value;
      } else {
        delete filters[key];
      }
      return { filters, page: 1 };
    }),
  resetFilters: () => set({ filters: {}, page: 1 }),
  setPage: (page) => set({ page }),
}));
