/**
 * Pinned-data loaders for review scripts.
 *  - `loadPinnedFile(path)` loads ANY pinned JSON ({manifest, bars}) and
 *    re-hashes the bars against the embedded sha256 (refuses on mismatch),
 *    mirroring scripts/canonical/lib/pinned-eval.ts `loadPinnedBars`.
 *  - `REVIEW_PINS` are the 2026-10-28 refresh files under review/data/.
 *  - `sessionDaily(dBars)` re-stamps start-stamped NY-session dailies to their
 *    close instant, exactly as the deploy harness does (pinned-eval
 *    `sessionDailyClose`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PriceBar } from "../../../src/lib/market-data/types";
import { sessionDailyClose } from "../../../scripts/canonical/lib/pinned-eval";

export interface PinnedManifest {
  ticker: string;
  instrument: string;
  granularity: string;
  price: string;
  source: string;
  from: string;
  last_bar: string;
  bar_count: number;
  sha256: string;
  fetched_at: string;
}

export function loadPinnedFile(relPath: string): { manifest: PinnedManifest; bars: PriceBar[] } {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), relPath), "utf-8")) as {
    manifest: PinnedManifest;
    bars: PriceBar[];
  };
  const sha = createHash("sha256").update(JSON.stringify(raw.bars)).digest("hex");
  if (sha !== raw.manifest.sha256) {
    throw new Error(`pinned file ${relPath}: sha256 mismatch (file ${raw.manifest.sha256.slice(0, 12)}…, computed ${sha.slice(0, 12)}…) — refusing`);
  }
  return raw;
}

export const CANONICAL_PINS = {
  h4: "scripts/canonical/data/xau-usd-h4-pinned.json",
  d: "scripts/canonical/data/xau-usd-d-pinned.json",
  h1: "scripts/canonical/data/xau-usd-h1-pinned.json",
} as const;

export const REVIEW_PINS = {
  h4: "review/data/xau-usd-h4-pinned-2026-10-28.json",
  d: "review/data/xau-usd-d-pinned-2026-10-28.json",
  h1: "review/data/xau-usd-h1-pinned-2026-10-28.json",
} as const;

export function sessionDaily(dBars: PriceBar[]): PriceBar[] {
  return sessionDailyClose(dBars);
}

/** Merge two bar series by date (later file wins on overlap), sorted. */
export function mergeBars(a: PriceBar[], b: PriceBar[]): PriceBar[] {
  const m = new Map<string, PriceBar>();
  for (const x of a) m.set(x.date, x);
  for (const x of b) m.set(x.date, x);
  return [...m.values()].sort((x, y) => x.date.localeCompare(y.date));
}
