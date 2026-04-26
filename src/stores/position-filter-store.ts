import { create } from "zustand";
import type { PositionFilters } from "@/types/position";

interface PositionFilterState {
  filters: PositionFilters;
  page: number;
  setFilter: <K extends keyof PositionFilters>(key: K, value: PositionFilters[K]) => void;
  resetFilters: () => void;
  setPage: (page: number) => void;
}

export const usePositionFilterStore = create<PositionFilterState>((set) => ({
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
