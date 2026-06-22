/**
 * B.1.8 — regression tests for the broker-spread-sample helpers
 * (2026-06-22 NIGHT LATE).
 *
 * Pure-function helpers backing `scripts/canonical/capture-broker-spread.ts`.
 * Tests verify the sample-build math + degenerate-input rejection +
 * JSONL serialization round-trip.
 *
 * Coverage (12 tests):
 *
 *  buildBrokerSpreadSample — math + rejection (9):
 *   - Happy path: forex EUR/USD pipSize 0.0001 → 1pip spread
 *   - Happy path: gold XAU/USD pipSize 0.01 → spread in 0.01 units
 *   - Unknown ticker (not in catalog) → spread_pips=null, raw_spread populated
 *   - NaN bid → null (degenerate)
 *   - NaN ask → null (degenerate)
 *   - Negative bid → null (broker data corruption)
 *   - Zero ask → null
 *   - bid === ask (locked market) → null
 *   - bid > ask (crossed market) → null
 *
 *  buildBrokerSpreadSample — payload completeness (1):
 *   - All fields preserved verbatim (captured_at, ids, ticker, broker_quote_time)
 *
 *  serializeSampleAsJsonl (2):
 *   - Produces single-line JSON without trailing newline
 *   - Round-trips via JSON.parse
 */
import { describe, expect, it } from "vitest";
import {
  buildBrokerSpreadSample,
  serializeSampleAsJsonl,
} from "./broker-spread-sample";

const CAPTURED_AT = "2026-06-22T12:00:00.000Z";

// ======================================================================
// buildBrokerSpreadSample — math + degenerate-input rejection
// ======================================================================

describe("buildBrokerSpreadSample — math + rejection", () => {
  it("forex EUR/USD pipSize 0.0001 → 1pip spread", () => {
    const s = buildBrokerSpreadSample({
      captured_at: CAPTURED_AT,
      broker_connection_id: "b1",
      broker_label: "Test",
      ticker: "EUR/USD",
      bid: 1.0850,
      ask: 1.0851,
    });
    expect(s).not.toBeNull();
    expect(s!.raw_spread).toBeCloseTo(0.0001, 5);
    expect(s!.spread_pips).toBeCloseTo(1, 5);
  });

  it("gold XAU/USD pipSize 0.01 → spread in pipSize units", () => {
    const s = buildBrokerSpreadSample({
      captured_at: CAPTURED_AT,
      broker_connection_id: "b1",
      broker_label: "Test",
      ticker: "XAU/USD",
      bid: 3055.20,
      ask: 3055.55,
    });
    expect(s).not.toBeNull();
    expect(s!.raw_spread).toBeCloseTo(0.35, 5);
    expect(s!.spread_pips).toBeCloseTo(35, 2);
  });

  it("unknown ticker (not in catalog) → spread_pips=null, raw_spread populated", () => {
    const s = buildBrokerSpreadSample({
      captured_at: CAPTURED_AT,
      broker_connection_id: "b1",
      broker_label: "Test",
      ticker: "UNKNOWN/USD",
      bid: 100,
      ask: 101,
    });
    expect(s).not.toBeNull();
    expect(s!.raw_spread).toBe(1);
    expect(s!.spread_pips).toBeNull();
  });

  it("NaN bid → null (degenerate)", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: NaN,
        ask: 1.0851,
      })
    ).toBeNull();
  });

  it("NaN ask → null", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: 1.0850,
        ask: NaN,
      })
    ).toBeNull();
  });

  it("negative bid → null (broker data corruption)", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: -1,
        ask: 1.0851,
      })
    ).toBeNull();
  });

  it("zero ask → null", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: 1.0850,
        ask: 0,
      })
    ).toBeNull();
  });

  it("bid === ask (locked market) → null", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: 1.0850,
        ask: 1.0850,
      })
    ).toBeNull();
  });

  it("bid > ask (crossed market — broker bug) → null", () => {
    expect(
      buildBrokerSpreadSample({
        captured_at: CAPTURED_AT,
        broker_connection_id: "b1",
        broker_label: "Test",
        ticker: "EUR/USD",
        bid: 1.0852,
        ask: 1.0850,
      })
    ).toBeNull();
  });
});

// ======================================================================
// Payload completeness
// ======================================================================

describe("buildBrokerSpreadSample — payload completeness", () => {
  it("all input fields preserved verbatim on the output sample", () => {
    const s = buildBrokerSpreadSample({
      captured_at: CAPTURED_AT,
      broker_connection_id: "conn-uuid-12345",
      broker_label: "FTMO Demo $100K",
      ticker: "GBP/USD",
      bid: 1.2750,
      ask: 1.2760,
      broker_quote_time: "2026-06-22T11:59:58.500Z",
    });
    expect(s).toMatchObject({
      captured_at: CAPTURED_AT,
      broker_connection_id: "conn-uuid-12345",
      broker_label: "FTMO Demo $100K",
      ticker: "GBP/USD",
      bid: 1.2750,
      ask: 1.2760,
      broker_quote_time: "2026-06-22T11:59:58.500Z",
    });
  });
});

// ======================================================================
// serializeSampleAsJsonl
// ======================================================================

describe("serializeSampleAsJsonl", () => {
  const sample = buildBrokerSpreadSample({
    captured_at: CAPTURED_AT,
    broker_connection_id: "b1",
    broker_label: "Test",
    ticker: "EUR/USD",
    bid: 1.0850,
    ask: 1.0851,
  })!;

  it("produces single-line JSON without trailing newline", () => {
    const line = serializeSampleAsJsonl(sample);
    expect(line).not.toContain("\n");
    expect(line).not.toMatch(/\s$/);
    expect(line.startsWith("{") && line.endsWith("}")).toBe(true);
  });

  it("round-trips via JSON.parse with field equality", () => {
    const line = serializeSampleAsJsonl(sample);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual(sample);
  });
});
