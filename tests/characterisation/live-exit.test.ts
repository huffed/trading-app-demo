/**
 * E0 (decision 0014; docs/MODERNISATION.md E0): a golden position's stop and target exits through the live engine,
 * the entry through `scanAlgorithm` and each exit through the 5-minute manage tick, `manageActiveAlgorithms`
 * (src/lib/scan/manage.ts), with the database, the feed and the broker stubbed as in live-entry.test.ts.
 *
 * Two golden trades of "Engulfing25+DailyBias 4h" (tests/golden/): the 2026-01-06 10:00Z long, stopped out on
 * 2026-01-07, and the 2026-01-19 14:00Z long, which reaches its target on 2026-01-20. Each entry is production's
 * path: a scan 30 s after the signal bar closes, with a Twelve Data quote at the next bar's open. Each exit is tried
 * two ways: a quote at the level (stop or target) during the bar in which the backtester exits, the first price a
 * market trading through the level prints; and no quote, the engine's fallback to bar closes, at every bar close of
 * the golden exit day. Where live and golden agree the test asserts them equal; where they differ, an `it.fails`
 * names the Part 2 item and the DEBT id.
 *
 * Nothing here reaches out: `fetch` throws, the broker registry throws if called, and the bar, quote, cache and
 * calendar modules are mocked. The database is tests/helpers/fake-supabase.ts.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { getFreshPricesForScan } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import { scanAlgorithm } from "@/lib/scan/engine";
import { manageActiveAlgorithms, type ManageResult } from "@/lib/scan/manage";
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
  getCachedPrices: vi.fn(),
  savePricesToCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/market-data/twelve-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market-data/twelve-data")>()),
  fetchBatchQuotes: vi.fn(),
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
const HOUR = 3_600_000;
/** The paper book's risk per trade: 0.42% of $100,000. */
const ONE_R = 420;
/** The live engine's exit reason for each of the backtester's (D-01: the vocabularies differ). */
const LIVE_REASON: Record<string, string> = {
  stop_loss_hit: "stop_loss",
  take_profit_hit: "take_profit",
};

const H4 = loadPinnedBars("XAU/USD", "h4").bars.filter((b) => b.date >= "2025-10-01");
const D1 = loadPinnedBars("XAU/USD", "d").bars.filter((b) => b.date >= "2025-06-01");

/** The bars closed by `at`: an H4 bar four hours after it opens, a D1 bar a day after. */
function closedBy(bars: PriceBar[], hours: number, at: string): PriceBar[] {
  return bars.filter((b) => Date.parse(b.date) + hours * HOUR <= Date.parse(at));
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

/** The golden backtest's trade for this algorithm on a signal bar. */
function goldenTrade(
  signalBar: string
): GoldenFile["runs"]["100k_paper_capital"]["trades"][number] {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
  const trade = golden.runs["100k_paper_capital"].trades.find(
    (t) => t.algorithm === ALGO_NAME && t.entry_date === signalBar
  );
  if (!trade) throw new Error(`the golden file has no trade on ${signalBar}`);
  return trade;
}

const fetchStub = vi.fn(() => Promise.reject(new Error("E0 stub: network")));
let db: FakeDatabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", fetchStub);
  vi.stubEnv("OPERATOR_USER_ID", USER);
  const { rules, name, status } = algorithm();
  db = new FakeDatabase({
    algorithms: [
      {
        id: ALGO_ID,
        user_id: USER,
        name,
        rules,
        status,
        live_trading_enabled: false,
        broker_connection_id: null,
      },
    ],
  });
});

afterEach(() => {
  expect(fetchStub).not.toHaveBeenCalled();
  expect(getBrokerAdapter).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Moves the clock to `at` and serves the bars closed by then and, unless null, one quote. */
function marketAt(at: string, quote: number | null): void {
  vi.setSystemTime(new Date(at));
  const h4 = closedBy(H4, 4, at);
  const d1 = closedBy(D1, 24, at);
  vi.mocked(getFreshPricesForScan).mockImplementation((_t, _s, interval) =>
    Promise.resolve(interval === "1day" ? d1 : h4)
  );
  vi.mocked(getCachedPrices).mockImplementation((_t, _s, interval) =>
    Promise.resolve(interval === "1day" ? d1 : null)
  );
  vi.mocked(fetchBatchQuotes).mockResolvedValue(
    new Map(quote === null ? [] : [["XAU/USD", quote]])
  );
}

/** The scan after the signal bar closes; returns the position it opened. */
async function enter(at: string, quote: number): Promise<Row> {
  marketAt(at, quote);
  const result = await scanAlgorithm(db.client(), USER, algorithm());
  expect([result.errors, result.positions_opened]).toEqual([[], 1]);
  return db.rows("paper_positions")[0];
}

async function manage(at: string, quote: number | null): Promise<ManageResult[]> {
  marketAt(at, quote);
  return manageActiveAlgorithms(db.client());
}

/** Every H4 bar close of a day, 30 s after it, as the manage tick sees them. */
function closesOf(day: string): string[] {
  return [2, 6, 10, 14, 18, 22].map((h) => `${day}T${String(h).padStart(2, "0")}:00:30.000Z`);
}

describe("E0: a golden stop-out through manageActiveAlgorithms (the 2026-01-06 long, stopped 2026-01-07)", () => {
  const golden = goldenTrade("2026-01-06T10:00:00.000Z");
  let opened: Row;

  beforeEach(async () => {
    opened = await enter("2026-01-06T14:00:30.000Z", 4468.165);
  });

  describe("a quote at the stop in the 2026-01-07 14:00Z bar, the only bar whose low (4423.385) reaches it", () => {
    let results: ManageResult[];
    let row: Row;

    beforeEach(async () => {
      results = await manage("2026-01-07T16:00:00.000Z", opened.stop_loss_price as number);
      row = db.rows("paper_positions")[0];
    });

    it("closes the position at the quote with a stop_loss_hit event, losing 1 R", () => {
      expect(results.map((r) => [r.positions_inspected, r.positions_closed, r.errors])).toEqual([
        [1, 1, []],
      ]);
      expect(row).toMatchObject({
        status: "closed",
        exit_price: opened.stop_loss_price,
        current_price: opened.stop_loss_price,
        closed_at: "2026-01-07T16:00:00.000Z",
        unrealized_pnl: 0,
      });
      expect(row.realized_pnl).toBeCloseTo(-ONE_R, 6);
      expect(db.rows("activity_log").at(-1)).toMatchObject({
        event_type: "stop_loss_hit",
        position_id: row.id,
      });
    });

    it("exits on the golden exit day, for the same reason (D-01: stop_loss live, stop_loss_hit in the backtester)", () => {
      expect(String(row.closed_at).slice(0, 10)).toBe(golden.exit_date);
      expect(row.exit_reason).toBe(LIVE_REASON[golden.exit_reason]);
    });

    it.fails(
      "fills at the backtester's exit price (P2; D-02: live fills at the quote, the backtester at the stop less slippage)",
      () => {
        expect(row.exit_price).toBeCloseTo(golden.exit_price, 4);
      }
    );

    it.fails("realizes the backtester's R (P2; D-02: the fills and the R formulas differ)", () => {
      expect((row.realized_pnl as number) / ONE_R).toBeCloseTo(golden.r_nominal ?? Number.NaN, 2);
    });
  });

  describe("no quote: the engine's fallback to bar closes, none of 2026-01-07's at or below the stop", () => {
    beforeEach(async () => {
      for (const at of closesOf("2026-01-07")) await manage(at, null);
    });

    it("keeps the position open, marked at the day's last close (4456.65)", () => {
      expect(db.rows("paper_positions")[0]).toMatchObject({
        status: "open",
        current_price: 4456.65,
      });
    });

    it.fails(
      "closes on the golden exit day (P2; D-02: live detects on a price, the backtester on the bar's low; D-04: with no quote, on a close)",
      () => {
        expect(db.rows("paper_positions")[0].status).toBe("closed");
      }
    );
  });
});

describe("E0: a golden target exit through manageActiveAlgorithms (the 2026-01-19 14:00Z long, target 2026-01-20)", () => {
  const golden = goldenTrade("2026-01-19T14:00:00.000Z");
  let opened: Row;

  beforeEach(async () => {
    opened = await enter("2026-01-19T18:00:30.000Z", 4676.35);
  });

  describe("a quote at the target in the 2026-01-20 14:00Z bar, the first whose high (4762.47) reaches it", () => {
    let row: Row;

    beforeEach(async () => {
      await manage("2026-01-20T16:00:00.000Z", opened.take_profit_price as number);
      row = db.rows("paper_positions")[0];
    });

    it("closes the position at the quote with a take_profit_hit event, making 2.5 R", () => {
      expect(row).toMatchObject({
        status: "closed",
        exit_price: opened.take_profit_price,
        unrealized_pnl: 0,
      });
      expect(row.realized_pnl).toBeCloseTo(2.5 * ONE_R, 6);
      expect(db.rows("activity_log").at(-1)).toMatchObject({
        event_type: "take_profit_hit",
        position_id: row.id,
      });
    });

    it("exits on the golden exit day, for the same reason (D-01: take_profit live, take_profit_hit in the backtester)", () => {
      expect(String(row.closed_at).slice(0, 10)).toBe(golden.exit_date);
      expect(row.exit_reason).toBe(LIVE_REASON[golden.exit_reason]);
    });

    it.fails(
      "fills at the backtester's exit price (P2; D-02: live fills at the quote, the backtester at the target less slippage)",
      () => {
        expect(row.exit_price).toBeCloseTo(golden.exit_price, 4);
      }
    );

    it.fails("realizes the backtester's R (P2; D-02: the fills and the R formulas differ)", () => {
      expect((row.realized_pnl as number) / ONE_R).toBeCloseTo(golden.r_nominal ?? Number.NaN, 2);
    });
  });

  describe("no quote: the engine's fallback to bar closes on 2026-01-20", () => {
    beforeEach(async () => {
      for (const at of closesOf("2026-01-20")) await manage(at, null);
    });

    it("closes at the first close through the target, the 18:00Z bar's (4763.37), on the golden exit day", () => {
      const [row] = db.rows("paper_positions");
      expect(row).toMatchObject({
        status: "closed",
        exit_reason: "take_profit",
        exit_price: 4763.37,
      });
      expect(String(row.closed_at).slice(0, 10)).toBe(golden.exit_date);
    });

    it.fails(
      "fills at the backtester's exit price (P2; D-02: live fills at a close past the target; D-04: with no quote, silently)",
      () => {
        expect(db.rows("paper_positions")[0].exit_price).toBeCloseTo(golden.exit_price, 4);
      }
    );
  });
});

describe("E0: the stub's embeds and not(), as the manage tick uses them", () => {
  const position: Row = {
    user_id: USER,
    algorithm_id: ALGO_ID,
    ticker: "XAU/USD",
    entry_price: 1,
    quantity: 1,
    notional_value: 1,
  };

  it("joins through algorithm_id, drops a row an !inner embed misses, and filters on the embedded table", async () => {
    const orphan = { ...position, algorithm_id: "00000000-0000-4000-8000-000000000000" };
    const stub = new FakeDatabase({
      algorithms: [{ id: ALGO_ID, status: "paused" }],
      paper_positions: [position, orphan],
    });
    const select = () =>
      stub.client().from("paper_positions").select("*, algorithms!inner(id, status)");
    const rows = (await select()).data as Row[];
    expect(rows.map((r) => (r.algorithms as Row).status)).toEqual(["paused"]);
    expect((await select().eq("algorithms.status", "active")).data).toEqual([]);
  });

  it("not(column, 'is', null) keeps the rows where the column is set", async () => {
    const stub = new FakeDatabase({
      paper_positions: [position, { ...position, broker_position_id: "b-1" }],
    });
    const { data } = await stub
      .client()
      .from("paper_positions")
      .select("*")
      .not("broker_position_id", "is", null);
    expect((data as Row[]).map((r) => r.broker_position_id)).toEqual(["b-1"]);
  });
});
