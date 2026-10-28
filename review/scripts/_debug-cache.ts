import { readOnlySupabase } from "./lib/env";
import { CANONICAL_PINS, REVIEW_PINS, loadPinnedFile, mergeBars } from "./lib/pins";
import type { PriceBar } from "../../src/lib/market-data/types";
(async () => {
  const h4 = mergeBars(loadPinnedFile(CANONICAL_PINS.h4).bars, loadPinnedFile(REVIEW_PINS.h4).bars);
  const byDate = new Set(h4.map((b) => b.date));
  const sb = readOnlySupabase();
  const { data } = await sb.from("price_cache").select("bars").eq("ticker", "XAU/USD").eq("interval", "4h").eq("output_size", "full").maybeSingle();
  const cb = (data!.bars as PriceBar[]);
  const foreign = cb.filter((b) => !byDate.has(b.date));
  console.log(`foreign=${foreign.length}`); console.log(foreign.map((b) => `${b.date} v=${b.volume}`).join("\n"));
  // what does OANDA have around the first foreign date?
  if (foreign[0]) { const t = Date.parse(foreign[0].date); console.log("OANDA bars within ±8h of first foreign:", h4.filter((b) => Math.abs(Date.parse(b.date) - t) <= 8 * 3600_000).map((b) => b.date).join(", ")); }
})();
