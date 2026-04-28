import type { PositionFilters } from "@/types/position";
import { createFilterStore } from "./create-filter-store";

export const usePositionFilterStore = createFilterStore<PositionFilters>();
