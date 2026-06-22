/**
 * Broker spread sample — pure helpers extracted from the capture script
 * (`scripts/canonical/capture-broker-spread.ts`) so the math + JSONL
 * serialization have unit tests. B.1.8 closure (2026-06-22 NIGHT LATE).
 *
 * The capture script collects (broker, ticker, bid, ask) samples that
 * the eventual calibration analysis will correlate against ATR ratios
 * to validate/refute the spread-gate ATR-proxy used in the backtest
 * fidelity layer. Per CLAUDE.md: "Directionally correct (high vol →
 * more refusals), not magnitude-correct. To validate properly, capture
 * ≥50 broker spread samples per symbol + matching ATRs + measure
 * correlation."
 *
 * This module owns the sample's CONSTRUCTION + SERIALIZATION shape.
 * Mock-injecting `getInstrumentMeta` keeps the math fully testable.
 */
import { getInstrumentMeta } from "@/lib/constants/markets";

export interface BrokerSpreadSample {
  /** ISO timestamp when the quote was captured by the sampler. */
  captured_at: string;
  broker_connection_id: string;
  broker_label: string;
  ticker: string;
  bid: number;
  ask: number;
  /** Raw bid-ask delta in instrument quote-currency units. */
  raw_spread: number;
  /** Spread in pips per the instrument's pipSize (null if instrument
   *  isn't in the catalog — operator should add it before depending on
   *  pip math for that symbol). */
  spread_pips: number | null;
  /** Broker-reported quote timestamp when the adapter surfaces it.
   *  Used by the calibration step to align samples with bar windows. */
  broker_quote_time?: string;
}

/**
 * Convert a raw (bid, ask) pair into a structured sample row. Pure
 * function — same input → same output. The captured_at parameter is
 * injected (not derived from new Date()) so tests + cron invocations
 * can control the timestamp.
 *
 * Rejects degenerate inputs (NaN / negative / bid >= ask) by returning
 * null — caller decides whether to log + skip OR throw. The script
 * logs + skips so one degenerate broker doesn't abort the batch.
 */
export function buildBrokerSpreadSample(args: {
  captured_at: string;
  broker_connection_id: string;
  broker_label: string;
  ticker: string;
  bid: number;
  ask: number;
  broker_quote_time?: string;
}): BrokerSpreadSample | null {
  if (!Number.isFinite(args.bid) || !Number.isFinite(args.ask)) return null;
  if (args.bid <= 0 || args.ask <= 0) return null;
  if (args.bid >= args.ask) return null; // crossed/locked markets — broker bug, not data
  const raw_spread = args.ask - args.bid;
  const meta = getInstrumentMeta(args.ticker);
  const spread_pips = meta ? raw_spread / meta.pipSize : null;
  return {
    captured_at: args.captured_at,
    broker_connection_id: args.broker_connection_id,
    broker_label: args.broker_label,
    ticker: args.ticker,
    bid: args.bid,
    ask: args.ask,
    raw_spread,
    spread_pips,
    broker_quote_time: args.broker_quote_time,
  };
}

/**
 * Serialize a sample row to a JSONL line (NO trailing newline — caller
 * appends \n). One sample per line so the file is append-only +
 * grep-friendly + works with `cat | jq -s '.'` for batch analysis.
 */
export function serializeSampleAsJsonl(sample: BrokerSpreadSample): string {
  return JSON.stringify(sample);
}
