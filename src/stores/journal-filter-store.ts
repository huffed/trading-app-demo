import type { JournalFilters } from "@/types/journal";
import { createFilterStore } from "./create-filter-store";

export const useJournalFilterStore = createFilterStore<JournalFilters>();
