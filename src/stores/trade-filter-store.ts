import type { TradeFilters } from "@/types/trade";
import { createFilterStore } from "./create-filter-store";

export const useTradeFilterStore = createFilterStore<TradeFilters>();
