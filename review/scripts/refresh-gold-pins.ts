/**
 * Review-only refresh of XAU/USD bars from OANDA practice into NEW pinned
 * files under review/data/ (never touches scripts/canonical/data/).
 * Logic copied from scripts/canonical/fetch-pinned-history.ts (E2.19) so the
 * manifest + sha256 format is identical; only the output path and defaults
 * differ. Authorised by the operator 2026-10-28 (Phase 0 reply, answer 5).
 *
 * Usage:
 *   pnpm dlx tsx review/scripts/refresh-gold-pins.ts
 *   TICKER="XAU/USD" GRANS="H4,D,H1" FROM="2026-06-01" TAG="2026-10-28" pnpm dlx tsx review/scripts/refresh-gold-pins.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvLocal } from "./lib/env";

loadEnvLocal();

const BASE_URL = "https://api-fxpractice.oanda.com";
const MAX_PAGES = 80;

interface OandaCandle {
  time: string;
  volume: number;
  complete: boolean;
  mid: { o: string; h: string; l: string; c: string };
}
interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchPaginated(token: string, instrument: string, granularity: string, fromIso: string): Promise<Bar[]> {
  const byDate = new Map<string, Bar>();
  let from = new Date(fromIso).toISOString();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${BASE_URL}/v3/instruments/${instrument}/candles` +
      `?granularity=${granularity}&price=M&count=5000&from=${encodeURIComponent(from)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`OANDA ${granularity} page ${page}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { candles?: OandaCandle[]; errorMessage?: string };
    if (data.errorMessage) throw new Error(`OANDA error: ${data.errorMessage}`);
    const candles = data.candles ?? [];
    let added = 0;
    for (const c of candles) {
      if (!c.complete) continue;
      const date = new Date(c.time).toISOString();
      if (!byDate.has(date)) added++;
      byDate.set(date, {
        date,
        open: parseFloat(c.mid.o),
        high: parseFloat(c.mid.h),
        low: parseFloat(c.mid.l),
        close: parseFloat(c.mid.c),
        volume: c.volume,
      });
    }
    process.stdout.write(`  ${granularity} page ${page}: ${candles.length} candles (+${added} new, total ${byDate.size})\n`);
    if (candles.length < 2 || added === 0) break;
    from = candles[candles.length - 1].time;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function main(): Promise<void> {
  const token = process.env.OANDA_API_KEY;
  if (!token) throw new Error("OANDA_API_KEY is not set");
  const ticker = process.env.TICKER ?? "XAU/USD";
  const grans = (process.env.GRANS ?? "H4,D,H1").split(",").map((g) => g.trim());
  const from = process.env.FROM ?? "2026-06-01";
  const tag = process.env.TAG ?? "2026-10-28";
  const instrument = ticker.replace("/", "_").toUpperCase();
  const outDir = resolve(process.cwd(), "review/data");
  mkdirSync(outDir, { recursive: true });

  for (const gran of grans) {
    console.log(`Fetching ${ticker} ${gran} from ${from} (OANDA practice, mid-price)…`);
    const bars = await fetchPaginated(token, instrument, gran, from);
    if (bars.length === 0) throw new Error(`no bars returned for ${gran}`);
    const sha256 = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
    const manifest = {
      ticker,
      instrument,
      granularity: gran,
      price: "M",
      source: "oanda-practice",
      from,
      last_bar: bars[bars.length - 1].date,
      bar_count: bars.length,
      sha256,
      fetched_at: new Date().toISOString(),
      review_note: "Phase 1 refresh (review/scripts/refresh-gold-pins.ts); canonical pins untouched.",
    };
    const fname = `${ticker.replace("/", "-").toLowerCase()}-${gran.toLowerCase()}-pinned-${tag}.json`;
    writeFileSync(resolve(outDir, fname), JSON.stringify({ manifest, bars }));
    console.log(`  ✓ ${fname}: ${bars.length} bars, ${bars[0].date} → ${manifest.last_bar}\n    sha256 ${sha256}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
