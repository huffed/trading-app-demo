import { create, type StoreApi, type UseBoundStore } from "zustand";

/**
 * Filter+pagination store factory. Three feature filter stores
 * (trades, journal, positions) had identical shapes; this is the shared
 * implementation. setFilter clears the field on a falsy value and resets
 * page to 1, since changing a filter invalidates the current page.
 */
export interface FilterStoreState<T extends object> {
  filters: T;
  page: number;
  setFilter: <K extends keyof T>(key: K, value: T[K] | undefined) => void;
  resetFilters: () => void;
  setPage: (page: number) => void;
}

export function createFilterStore<T extends object>(): UseBoundStore<
  StoreApi<FilterStoreState<T>>
> {
  // Generic-parameter erasure: at the type-system level `T extends object`
  // means "some object shape", but at runtime an empty literal `{}` is a
  // valid starting state for any T. The factory's caller fully specifies T,
  // so the only safe assertion site is here at the factory body.
  const emptyFilters: T = Object.create(null) as T;
  return create<FilterStoreState<T>>((set) => ({
    filters: emptyFilters,
    page: 1,
    setFilter: (key, value) =>
      set((state) => {
        const filters = { ...state.filters };
        if (value) {
          filters[key] = value as T[typeof key];
        } else {
          delete filters[key];
        }
        return { filters, page: 1 };
      }),
    resetFilters: () => set({ filters: Object.create(null) as T, page: 1 }),
    setPage: (page) => set({ page }),
  }));
}
