/**
 * Shared MetaApi constants — extracted from `metaapi.ts` on 2026-06-22
 * (CB.H1 pass 13) so the split order-side module (`metaapi-orders.ts`)
 * can share the region/host registry without circular imports.
 */
export type MetaApiRegion = "london" | "new-york" | "singapore";

export const REGION_HOSTS: Record<MetaApiRegion, string> = {
  london: "https://mt-client-api-v1.london.agiliumtrade.ai",
  "new-york": "https://mt-client-api-v1.new-york.agiliumtrade.ai",
  singapore: "https://mt-client-api-v1.singapore.agiliumtrade.ai",
};
