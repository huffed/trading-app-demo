/**
 * E0 (decision 0014; docs/MODERNISATION.md E0): the live engine's entry path end to end, through `scanAlgorithm`
 * (src/lib/scan/engine.ts), with the database, the price feed and the broker stubbed. The golden replay never runs
 * src/lib/scan/, so this is the first test of what the live engine writes when it opens a position.
 *
 * Scenario: "Engulfing25+DailyBias 4h" (the deployed rules of 2026-10-28, tests/golden/) scanned at 14:00:30Z on
 * 2026-01-06, just after the 10:00Z H4 bar closed. The golden backtest opens a long on that bar. The feed is the
 * pinned XAU/USD corpus: H4 bars through the 10:00Z bar, D1 bars through the last completed session. Quotes are
 * empty, so the engine prices at the last close. Capital is the paper book's $100,000.
 *
 * Nothing here reaches out: `fetch` throws, the broker registry throws if called, and the calendar, quote, cache and
 * price modules are mocked. The database is tests/helpers/fake-supabase.ts, which applies the migrations' CHECK lists.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import { getFreshPricesForScan } from "@/lib/market-data/prices";
import type { PriceBar } from "@/lib/market-data/types";
import { scanAlgorithm, type ScanResult } from "@/lib/scan/engine";
import { loadPinnedBars } from "../../scripts/canonical/lib/pinned-eval";
import { GOLDEN_PATH, loadRulesFixture, type GoldenFile } from "../golden/replay";
import { FakeDatabase, type Row } from "../helpers/fake-supabase";

vi.mock("@/lib/market-data/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market-data/prices")>()),
  getFreshPricesForScan: vi.fn(),
  fetchDailyPrices: vi.fn(() => Promise.reject(new Error("E0 stub: fetchDailyPrices"))),
}));
vi.mock("@/lib/market-data/price-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market-data/price-cache")>()),
  getCachedPrices: vi.fn(() => Promise.resolve(null)),
  savePricesToCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/market-data/twelve-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market-data/twelve-data")>()),
  fetchBatchQuotes: vi.fn(() => Promise.resolve(new Map<string, number>())),
}));
vi.mock("@/lib/market-data/economic-calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market-data/economic-calendar")>()),
  fetchEconomicCalendar: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/lib/brokers/registry", () => ({
  getBrokerAdapter: vi.fn(() => {
    throw new Error("E0 stub: the broker adapter was reached");
  }),
}));

const USER = "00000000-0000-4000-8000-0000000000e0";
const ALGO_ID = "52e911a6-b4ed-4507-b0a3-5414e40ec16c";
const ALGO_NAME = "Engulfing25+DailyBias 4h";
const SIGNAL_BAR = "2026-01-06T10:00:00.000Z";
const SCAN_AT = "2026-01-06T14:00:30.000Z";
const SLIPPAGE_BPS = 0.5;

function feed(): { h4: PriceBar[]; d1: PriceBar[] } {
  const h4 = loadPinnedBars("XAU/USD", "h4").bars.filter(
    (b) => b.date >= "2025-10-01" && b.date <= SIGNAL_BAR
  );
  const d1 = loadPinnedBars("XAU/USD", "d").bars.filter(
    (b) => b.date >= "2025-06-01" && b.date < "2026-01-05T22:00:00.000Z"
  );
  return { h4, d1 };
}

function algorithm(): Parameters<typeof scanAlgorithm>[2] {
  const found = loadRulesFixture().algorithms.find((a) => a.name === ALGO_NAME);
  if (!found) throw new Error(`the rules fixture has no ${ALGO_NAME}`);
  return {
    id: ALGO_ID,
    name: ALGO_NAME,
    description: "E0 scenario",
    rules: found.rules,
    capital: 100_000,
    status: "active",
    algorithm_watchlist: [{ ticker: "XAU/USD", name: "Gold" }],
    live_trading_enabled: false,
    broker_connection_id: null,
  };
}

/** The golden backtest's trade for this algorithm on the signal bar. */
function goldenTrade(): {
  entry_price: number;
  exit_price: number;
  exit_reason: string;
  side: string;
} {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
  const trade = golden.runs["100k_paper_capital"].trades.find(
    (t) => t.algorithm === ALGO_NAME && t.entry_date === SIGNAL_BAR
  );
  if (!trade) throw new Error("the golden file has no trade on the signal bar");
  return trade;
}

/** The row the engine writes, as observed on 2026-11-17 (the id and the stub's timestamp left out). */
const EXPECTED_ROW: Row = {
  algorithm_id: ALGO_ID,
  user_id: USER,
  ticker: "XAU/USD",
  side: "long",
  entry_price: 4468.09,
  current_price: 4468.09,
  quantity: 9.508760044194817,
  notional_value: 42485.99566586642,
  stop_loss_price: 4423.920203091894,
  initial_stop_loss_price: 4423.920203091894,
  take_profit_price: 4578.514492270266,
  entry_reason: {
    cohort: {
      entry_hour_utc: 14,
      entry_zone: "premium",
      position_in_range_pct: 96.18367903253795,
    },
    conditions_met: [
      {
        type: "pattern",
        pattern: "engulfing",
        direction: "bullish",
        lookback: undefined,
        ma_period: undefined,
      },
      {
        type: "pattern",
        pattern: "daily_bias",
        direction: "bullish",
        lookback: undefined,
        ma_period: 20,
      },
    ],
    signal_result: undefined,
  },
};

/** The signal_detected event the engine logs before it opens. */
const EXPECTED_SIGNAL: Row = {
  algorithm_id: ALGO_ID,
  user_id: USER,
  ticker: "XAU/USD",
  event_type: "signal_detected",
  position_id: null,
  details: {
    atr_current: 37.147969081062705,
    atr_threshold: 26.654598437847262,
    conditions_breakdown: [true, true],
    conditions_met: 2,
    conditions_total: 2,
    observed_spread_pips: undefined,
    sentiment_confidence: undefined,
    sentiment_signal: undefined,
    spread_status: undefined,
  },
};

/** A row without the stub's own id and timestamp. */
function engineFields({ id: _id, created_at: _created, ...rest }: Row): Row {
  return rest;
}

describe("E0: an entry through scanAlgorithm on the pinned corpus", () => {
  const fetchStub = vi.fn(() => Promise.reject(new Error("E0 stub: network")));
  let db: FakeDatabase;
  let result: ScanResult;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SCAN_AT));
    vi.stubGlobal("fetch", fetchStub);
    const { h4, d1 } = feed();
    vi.mocked(getFreshPricesForScan).mockImplementation((_ticker, _size, interval) =>
      Promise.resolve(interval === "1day" ? d1 : h4)
    );
    db = new FakeDatabase({ algorithms: [{ id: ALGO_ID, user_id: USER, backtest_results: null }] });
    result = await scanAlgorithm(db.client(), USER, algorithm());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("scans the ticker without an error and opens one position", () => {
    expect(result.errors).toEqual([]);
    expect(result.tickers_scanned).toBe(1);
    expect(result.positions_opened).toBe(1);
  });

  it("reaches neither the network nor the broker adapter", () => {
    expect(fetchStub).not.toHaveBeenCalled();
    expect(getBrokerAdapter).not.toHaveBeenCalled();
  });

  it("logs the scan, the signal and the opening, in order", () => {
    expect(db.rows("activity_log").map((r) => r.event_type)).toEqual([
      "scan_started",
      "signal_detected",
      "position_opened",
      "scan_completed",
    ]);
  });

  it("writes one paper position, long, at the signal bar's close, sized to 0.42% of $100,000", () => {
    const rows = db.rows("paper_positions");
    expect(rows).toHaveLength(1);
    expect(engineFields(rows[0])).toEqual(EXPECTED_ROW);
    const { entry_price, stop_loss_price, quantity } = rows[0] as Record<string, number>;
    expect(quantity * (entry_price - stop_loss_price)).toBeCloseTo(420, 6);
  });

  it("logs the signal's gates and the opening, the opening against the row it wrote", () => {
    const [signal, opened] = db.rows("activity_log").slice(1, 3);
    expect(engineFields(signal)).toEqual(EXPECTED_SIGNAL);
    expect(opened.position_id).toBe(db.rows("paper_positions")[0].id);
    expect(opened.details).toEqual({
      entry_price: 4468.09,
      notional_value: 42485.99566586642,
      quantity: 9.508760044194817,
      stop_loss_price: 4423.920203091894,
      take_profit_price: 4578.514492270266,
    });
  });

  it("puts the stop where the backtester does: its stop-out, less slippage, is the golden exit", () => {
    const golden = goldenTrade();
    expect(golden.exit_reason).toBe("stop_loss_hit");
    const stop = db.rows("paper_positions")[0].stop_loss_price as number;
    expect(stop * (1 - SLIPPAGE_BPS / 10_000)).toBeCloseTo(golden.exit_price, 4);
  });

  it.fails(
    "fills at the backtester's entry price (P2 decides; D-02: live fills at the quote or close, the backtester at close plus slippage)",
    () => {
      expect(db.rows("paper_positions")[0].entry_price).toBe(goldenTrade().entry_price);
    }
  );

  it("refuses no write at a CHECK constraint", () => {
    expect(db.writes.filter((w) => w.error !== null)).toEqual([]);
  });
});
