/**
 * B.1.8 — Broker spread sampler.
 *
 * Loops every metaapi broker_connections row × configured ticker list,
 * calls `adapter.fetchQuote(conn, ticker)`, and appends a JSONL row to
 * `scripts/broker-spread-samples.jsonl` (gitignored append-only log).
 *
 * The capture script's sole responsibility is COLLECTION. The
 * calibration analysis (correlate sample spread_pips against
 * concurrent ATR ratios from price_cache → validate or refute the
 * ATR-proxy used in the backtest spread gate) is a separate piece
 * of work that runs once enough samples accumulate (≥50/symbol per
 * CLAUDE.md). Without that analysis, today's backtest spread-gate
 * proxy is documented as "stress-period inference, not validated."
 *
 * Per-(broker × ticker) failure handling (intentional):
 *   - Catches the fetchQuote throw / null return + logs to stderr
 *   - Does NOT abort the batch — one broker × ticker failure doesn't
 *     blank the others
 *   - Script exits 0 (cron success) even with per-call failures
 *
 * Default ticker list matches the current library scope per CLAUDE.md:
 * `gold + USD/JPY + EUR/USD + GBP/USD`. Override via TICKERS env CSV.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/capture-broker-spread.ts
 *     # → samples default ticker list × all metaapi broker connections
 *   TICKERS="XAU/USD,EUR/USD" pnpm dlx tsx scripts/canonical/capture-broker-spread.ts
 *     # → restrict to a subset
 *   DRY=1 pnpm dlx tsx scripts/canonical/capture-broker-spread.ts
 *     # → print samples without appending to JSONL
 */
import { readFileSync, appendFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import type { BrokerConnection } from "@/lib/brokers/types";
import {
  buildBrokerSpreadSample,
  serializeSampleAsJsonl,
} from "@/lib/cohort/broker-spread-sample";

// Self-load .env.local
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const DRY = process.env.DRY === "1";
const DEFAULT_TICKERS = ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY"];
const TICKERS = (process.env.TICKERS ?? DEFAULT_TICKERS.join(","))
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t.length > 0);

const SAMPLES_PATH = resolve("scripts/broker-spread-samples.jsonl");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

interface ConnRow {
  id: string;
  label: string;
  provider: string;
  api_token: string;
  account_id: string;
  region: string | null;
  broker_name: string | null;
  status: string;
}

async function captureForConn(conn: ConnRow, tickers: string[]): Promise<number> {
  if (conn.provider !== "metaapi") {
    console.error(`SKIP ${conn.label}: provider="${conn.provider}" not metaapi`);
    return 0;
  }
  if (!conn.api_token || !conn.account_id) {
    console.error(`SKIP ${conn.label}: missing api_token or account_id`);
    return 0;
  }
  const adapter = getBrokerAdapter(conn.provider);
  if (!adapter) {
    console.error(`SKIP ${conn.label}: no adapter for provider="${conn.provider}"`);
    return 0;
  }

  // BrokerConnection shape — adapter contracts use this; pull only the
  // fields the adapter needs. status field isn't on BrokerConnection but
  // doesn't matter — we already filtered above.
  const conn_for_adapter = {
    id: conn.id,
    label: conn.label,
    provider: conn.provider,
    api_token: conn.api_token,
    account_id: conn.account_id,
    region: conn.region,
    broker_name: conn.broker_name,
  } as unknown as BrokerConnection;

  let written = 0;
  const capturedAt = new Date().toISOString();
  for (const ticker of tickers) {
    try {
      const quote = await adapter.fetchQuote(conn_for_adapter, ticker);
      if (!quote) {
        console.error(`SKIP ${conn.label} × ${ticker}: fetchQuote returned null`);
        continue;
      }
      const sample = buildBrokerSpreadSample({
        captured_at: capturedAt,
        broker_connection_id: conn.id,
        broker_label: conn.label,
        ticker,
        bid: quote.bid,
        ask: quote.ask,
        broker_quote_time: quote.time,
      });
      if (!sample) {
        console.error(`SKIP ${conn.label} × ${ticker}: degenerate quote (bid=${quote.bid}, ask=${quote.ask})`);
        continue;
      }
      console.log(
        `OK   ${conn.label} × ${ticker}: bid=${quote.bid} ask=${quote.ask} spread=${sample.raw_spread.toFixed(5)} ${sample.spread_pips != null ? `(${sample.spread_pips.toFixed(2)}pips)` : "(no pip math)"}`
      );
      if (!DRY) {
        appendFileSync(SAMPLES_PATH, serializeSampleAsJsonl(sample) + "\n");
        written++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`ERR  ${conn.label} × ${ticker}: ${msg}`);
    }
  }
  return written;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[capture-broker-spread] start ${startedAt} mode=${DRY ? "DRY" : "WRITE"} tickers=${TICKERS.join(",")}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: connections, error } = await supabase
    .from("broker_connections")
    .select("id, label, provider, api_token, account_id, region, broker_name, status")
    .eq("provider", "metaapi");
  if (error || !connections) {
    throw new Error(
      `load failed: message="${error?.message ?? "no data"}" code="${error?.code ?? "n/a"}" details="${error?.details ?? "n/a"}" hint="${error?.hint ?? "n/a"}"`
    );
  }

  const rows = connections as ConnRow[];
  if (rows.length === 0) {
    console.log("No metaapi broker connections — nothing to sample.");
    return;
  }

  console.log(`Sampling ${rows.length} broker connection(s) × ${TICKERS.length} ticker(s)...\n`);

  let totalWritten = 0;
  for (const conn of rows) {
    totalWritten += await captureForConn(conn, TICKERS);
  }

  console.log(
    `\nDone. ${DRY ? "DRY RUN — nothing written." : `Appended ${totalWritten} samples to ${SAMPLES_PATH}`}`
  );
}

void main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
