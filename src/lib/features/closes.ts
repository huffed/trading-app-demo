import type { Feature } from "./types";

/** Close prices from the first bar through `idx` inclusive; shared by the momentum and trend features. */
export function closesUpTo(bars: Parameters<Feature["compute"]>[0], idx: number): number[] {
  return bars.slice(0, idx + 1).map((b) => b.close);
}
