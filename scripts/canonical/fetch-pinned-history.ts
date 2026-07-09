/**
 * Fetch a PINNED research dataset from OANDA (deep history, paginated) and
 * write it to scripts/canonical/data/ as an immutable, hashed, versioned
 * file. E2.19 (2026-07-09).
 *
 * Why: research/validation previously read the mutable live `price_cache`
 * row, which live cron merges rewrite continuously. The 4h gold row's deep
 * 2016→2026 history (used by every Phase E/F backtest through 2026-06-29)
 * was silently reduced to a ~3.2yr provider-capped window + duplicate bars.
 * Verdict-grade runs must consume pinned files, never the live cache.
 *
 * Output shape per file:
 *   { manifest: { ticker, instrument, granularity, price, source, from,
 *     last_bar, bar_count, sha256, fetched_at }, bars: PriceBar[] }
 * Bars use the canonical fixed-width ISO+Z date format (DQ.2).
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/fetch-pinned-history.ts                 # XAU/USD H4+D from 2015-01-01
 *   TICKER="XAU/USD" GRANS="H4,D" FROM="2015-01-01" pnpm dlx tsx scripts/canonical/fetch-pinned-history.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvLocal();

const BASE_URL = "https://api-fxpractice.oanda.com";
const MAX_PAGES = 30; // safety backstop (~150K bars)

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

async function fetchPaginated(
  token: string,
  instrument: string,
  granularity: string,
  fromIso: string
): Promise<Bar[]> {
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
      const date = new Date(c.time).toISOString(); // canonical fixed-width ISO+Z
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
    process.stdout.write(
      `  ${granularity} page ${page}: ${candles.length} candles (+${added} new, total ${byDate.size})\n`
    );
    if (candles.length < 2 || added === 0) break;
    from = candles[candles.length - 1].time; // next page starts at last candle (overlap deduped)
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function main(): Promise<void> {
  const token = process.env.OANDA_API_KEY;
  if (!token) throw new Error("OANDA_API_KEY is not set");
  const ticker = process.env.TICKER ?? "XAU/USD";
  const grans = (process.env.GRANS ?? "H4,D").split(",").map((g) => g.trim());
  const from = process.env.FROM ?? "2015-01-01";
  const instrument = ticker.replace("/", "_").toUpperCase();

  const outDir = resolve(process.cwd(), "scripts/canonical/data");
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
    };
    const fname = `${ticker.replace("/", "-").toLowerCase()}-${gran.toLowerCase()}-pinned.json`;
    writeFileSync(resolve(outDir, fname), JSON.stringify({ manifest, bars }));
    console.log(
      `  ✓ ${fname}: ${bars.length} bars, ${bars[0].date} → ${manifest.last_bar}\n` +
      `    sha256 ${sha256.slice(0, 16)}…\n`
    );
  }
  console.log("Pinned datasets written. Verdict-grade runs must read these files (never live price_cache).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
