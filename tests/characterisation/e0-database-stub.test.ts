/**
 * E0 (decision 0014): the database stub's own rules, shown to fire. tests/helpers/fake-supabase.ts refuses what
 * PostgREST and Postgres would (tests/helpers/db-checks.ts); a rule that never fires would let a live-path scenario
 * pass on a write the database refuses. Nothing here reaches out: `fetch` throws and the broker registry is mocked to
 * throw, as in every E0 file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDatabase, type Row } from "../helpers/fake-supabase";

vi.mock("@/lib/brokers/registry", () => ({
  getBrokerAdapter: vi.fn(() => {
    throw new Error("E0 stub: the broker adapter was reached");
  }),
}));

const USER = "00000000-0000-4000-8000-0000000000e0";
const ALGO_ID = "52e911a6-b4ed-4507-b0a3-5414e40ec16c";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("E0 stub: network")))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * One refused write per rule of the stub, each against a row the stub accepts. "daily_loss_halt" and "dll_warning"
 * are values the engine writes and today's CHECKs refuse (D-01, audit A4); draft PR #291's migration widens those
 * lists and changes these two rows, as it flips the contract test's `it.fails`.
 */
const REFUSALS: [string, Row, string, string][] = [
  ["paper_positions", { side: "sideways" }, "23514", "paper_positions_side_check"],
  ["paper_positions", { status: "pending" }, "23514", "paper_positions_status_check"],
  ["paper_positions", { quantity: 0 }, "23514", "paper_positions_quantity_check"],
  ["paper_positions", { notional_value: 0 }, "23514", "paper_positions_notional_value_check"],
  ["paper_positions", { entry_price: 0 }, "23514", "paper_positions_entry_price_check"],
  [
    "paper_positions",
    { exit_reason: "daily_loss_halt" },
    "23514",
    "paper_positions_exit_reason_check",
  ],
  ["paper_positions", { ticker: null }, "23502", '"ticker"'],
  ["activity_log", { event_type: "dll_warning" }, "23514", "activity_log_event_type_check"],
  ["activity_log", { user_id: null }, "23502", '"user_id"'],
];

describe("E0: the database stub refuses what PostgREST and Postgres would", () => {
  const position: Row = {
    user_id: USER,
    algorithm_id: ALGO_ID,
    ticker: "XAU/USD",
    entry_price: 1,
    quantity: 1,
    notional_value: 1,
  };

  const valid: Record<string, Row> = {
    paper_positions: position,
    activity_log: { user_id: USER, event_type: "scan_started" },
  };

  it("refuses an unknown column, and returns a write's rows only after select()", async () => {
    const client = new FakeDatabase().client();
    const insert = (row: Row) => client.from("paper_positions").insert(row);
    expect((await insert({ ...position, typo: 1 })).error?.code).toBe("PGRST204");
    expect(await insert(position)).toEqual({ data: null, error: null });
    const stored = await insert(position).select().single();
    expect(stored.data).toMatchObject({ status: "open", side: "long", unrealized_pnl: 0 });
    const logged = await client.from("activity_log").insert(valid.activity_log).select().single();
    expect(logged.error).toBeNull();
  });

  it.each(REFUSALS)("refuses a %s row with %j: %s, %s", async (table, change, code, name) => {
    const { error } = await new FakeDatabase()
      .client()
      .from(table)
      .insert({ ...valid[table], ...change });
    expect(error?.code).toBe(code);
    expect(error?.message).toContain(name);
  });
});
