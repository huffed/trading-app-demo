/**
 * Dukascopy tick-data pipeline — phase 1 (E2.33, 2026-09-02).
 *
 * Downloads hour-granularity bi5 tick files (bid/ask, LZMA-alone
 * compressed, big-endian 20-byte records) and stores per-DAY gzip JSONL
 * under scripts/canonical/data/ticks/<inst>/<yyyy-mm-dd>.jsonl.gz with a
 * committed sha manifest (the raw corpus itself is GITIGNORED — hundreds
 * of MB — and reproducible from the archive; the manifest pins content).
 *
 * Purpose: a REAL spread model (by hour × instrument) for the 2026-10
 * round's friction, replacing catalog defaults calibrated from 37 fills.
 * First probe already shows Dukascopy raw XAU spread ≈ 1.4bps vs our
 * 0.4bps catalog number — shape-by-hour is the deliverable; absolute
 * levels get broker-scaled at consumption time.
 *
 * Format notes (verified against live probe 2026-09-02):
 *  - URL month is ZERO-BASED: /datafeed/XAUUSD/2026/08/01/12h_ticks.bi5
 *    is Sep 1 2026, 12:00 UTC.
 *  - Record: >u32 msOffsetInHour, >u32 ask, >u32 bid, >f32 askVol, >f32 bidVol.
 *  - Price divisors: XAUUSD 1e3, USDJPY 1e3, EURUSD/GBPUSD 1e5.
 *  - Decompression: system `xz -d --format=lzma` (bi5 = .lzma alone).
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/fetch-dukascopy-ticks.ts             # defaults: 4 instruments, last ~6 months
 *   INSTRUMENTS=XAUUSD FROM=2026-03-01 TO=2026-09-01 pnpm dlx tsx ...
 *
 * Resume-safe: a day already present in the manifest is skipped.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const TICKS_DIR = resolve(process.cwd(), "scripts/canonical/data/ticks");
const MANIFEST_PATH = resolve(process.cwd(), "scripts/canonical/data/ticks-manifest.json");

const DIVISOR: Record<string, number> = { XAUUSD: 1e3, USDJPY: 1e3, EURUSD: 1e5, GBPUSD: 1e5 };
/** Decoded-price sanity windows — abort loudly on scale drift. */
const SANITY: Record<string, [number, number]> = {
  XAUUSD: [1000, 10000],
  USDJPY: [60, 300],
  EURUSD: [0.5, 2.0],
  GBPUSD: [0.5, 2.5],
};

const INSTRUMENTS = (process.env.INSTRUMENTS ?? "XAUUSD,EURUSD,GBPUSD,USDJPY").split(",").map((s) => s.trim());
const TO = process.env.TO ?? new Date().toISOString().slice(0, 10);
const FROM =
  process.env.FROM ?? new Date(Date.parse(TO) - 183 * 86_400_000).toISOString().slice(0, 10);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2); // polite: free archive, 429s fast
const HOUR_CHUNK = 4; // hours fetched per burst within a day
const PACE_MS = Number(process.env.PACE_MS ?? 250); // gap between bursts

interface DayEntry {
  sha256: string;
  ticks: number;
  bytes: number;
}
type Manifest = Record<string, Record<string, DayEntry>>; // inst → day → entry

function loadManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

async function fetchHour(inst: string, day: Date, hour: number): Promise<Buffer | null> {
  const url = `https://datafeed.dukascopy.com/datafeed/${inst}/${day.getUTCFullYear()}/${String(day.getUTCMonth()).padStart(2, "0")}/${String(day.getUTCDate()).padStart(2, "0")}/${String(hour).padStart(2, "0")}h_ticks.bi5`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (research; quanttrader tick pipeline)" } });
      if (res.status === 404) return null;
      if (res.status === 429) {
        // Free archive — back off hard and retry rather than hammering.
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length === 0 ? null : buf;
    } catch (err) {
      if (attempt === 5) throw new Error(`${url}: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: still 429 after 6 backoff attempts`);
}

function decodeHour(inst: string, raw: Buffer, hourStartMs: number): Array<[number, number, number]> {
  const plain: Buffer = execFileSync("xz", ["-d", "--format=lzma", "-c"], {
    input: raw,
    maxBuffer: 64 * 1024 * 1024,
  });
  const div = DIVISOR[inst];
  const [lo, hi] = SANITY[inst];
  const out: Array<[number, number, number]> = [];
  for (let off = 0; off + 20 <= plain.length; off += 20) {
    const ms = plain.readUInt32BE(off);
    const ask = plain.readUInt32BE(off + 4) / div;
    const bid = plain.readUInt32BE(off + 8) / div;
    if (bid < lo || ask > hi || ask < bid - 1e-9) {
      throw new Error(`${inst}: insane tick bid=${bid} ask=${ask} — divisor/scale drift, refusing`);
    }
    out.push([hourStartMs + ms, bid, ask]);
  }
  return out;
}

async function fetchDay(inst: string, dayIso: string): Promise<DayEntry | null> {
  const day = new Date(`${dayIso}T00:00:00Z`);
  const hourBufs: Array<Buffer | null> = [];
  for (let h = 0; h < 24; h += HOUR_CHUNK) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(HOUR_CHUNK, 24 - h) }, (_, i) => fetchHour(inst, day, h + i))
    );
    hourBufs.push(...chunk);
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
  const ticks: Array<[number, number, number]> = [];
  hourBufs.forEach((buf, h) => {
    if (buf) ticks.push(...decodeHour(inst, buf, day.getTime() + h * 3_600_000));
  });
  if (ticks.length === 0) return null; // weekend/holiday
  const jsonl = ticks.map((t) => JSON.stringify(t)).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(jsonl));
  const dir = resolve(TICKS_DIR, inst.toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${dayIso}.jsonl.gz`), gz);
  return { sha256: createHash("sha256").update(gz).digest("hex"), ticks: ticks.length, bytes: gz.length };
}

async function main(): Promise<void> {
  if (!existsSync("/usr/bin/xz") && !process.env.PATH?.includes("bin")) {
    // xz resolution happens via PATH in execFileSync; this is just a hint line.
  }
  const manifest = loadManifest();
  const days: string[] = [];
  for (let t = Date.parse(FROM); t <= Date.parse(TO); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  console.log(`Dukascopy fetch: ${INSTRUMENTS.join(",")} × ${days.length} days (${FROM} → ${TO})`);
  let done = 0, skipped = 0, empty = 0, totalTicks = 0;
  const failures: string[] = [];
  for (const inst of INSTRUMENTS) {
    manifest[inst] = manifest[inst] ?? {};
    // simple bounded concurrency over days
    let i = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const idx = i++;
        if (idx >= days.length) return;
        const dayIso = days[idx];
        if (manifest[inst][dayIso]) { skipped++; continue; }
        let entry: DayEntry | null;
        try {
          entry = await fetchDay(inst, dayIso);
        } catch (err) {
          failures.push(`${inst} ${dayIso}: ${err instanceof Error ? err.message : err}`);
          continue; // not in manifest → a resume re-attempts it
        }
        if (entry === null) { empty++; continue; }
        manifest[inst][dayIso] = entry;
        totalTicks += entry.ticks;
        done++;
        if (done % 5 === 0) {
          writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1));
          console.log(`  ${done} days stored (${(totalTicks / 1e6).toFixed(1)}M ticks) … latest ${inst} ${dayIso}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1));
    console.log(`${inst}: complete (${Object.keys(manifest[inst]).length} days in manifest)`);
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1));
  console.log(`DONE: +${done} days, ${skipped} already present, ${empty} empty (weekend/holiday), ${(totalTicks / 1e6).toFixed(1)}M new ticks`);
  if (failures.length) {
    console.log(`FAILED ${failures.length} days (re-run to resume them):`);
    for (const f of failures.slice(0, 10)) console.log("  " + f);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("[fetch-dukascopy-ticks]", err instanceof Error ? err.message : err);
  process.exit(1);
});
