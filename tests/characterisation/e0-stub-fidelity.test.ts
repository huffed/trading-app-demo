/**
 * E0 (decision 0014): the database stub's gaps that docs/DEBT.md D-47 listed and this file shows closed. The rules of
 * paper_positions and activity_log come from the migrations (tests/helpers/migration-schema.ts), so a migration
 * changes the stub with it, and one the stub cannot read fails here. What the stub stores, records and hands out are
 * separate JSON copies. A call it does not support is recorded, and the record must be empty after every test
 * (tests/helpers/fake-supabase.ts). Nothing here reaches out: `fetch` throws and the broker registry is mocked to
 * throw, as in every E0 file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tables } from "@/lib/supabase/database.types";
import { FakeDatabase, type Row } from "../helpers/fake-supabase";
import { deriveTables, readMigrations } from "../helpers/migration-schema";

vi.mock("@/lib/brokers/registry", () => ({
  getBrokerAdapter: vi.fn(() => {
    throw new Error("E0 stub: the broker adapter was reached");
  }),
}));

const USER = "00000000-0000-4000-8000-0000000000e0";
const ALGO_ID = "52e911a6-b4ed-4507-b0a3-5414e40ec16c";
const POSITION: Row = {
  user_id: USER,
  algorithm_id: ALGO_ID,
  ticker: "XAU/USD",
  entry_price: 1,
  quantity: 1,
  notional_value: 1,
};

/** The generated types' columns: tsc fails here when `make db-types` changes them, the first test when they disagree. */
const PAPER_POSITION_COLUMNS: Record<keyof Tables<"paper_positions">, true> = {
  algorithm_id: true,
  broker_close_id: true,
  broker_close_price: true,
  broker_error: true,
  broker_fill_price: true,
  broker_order_id: true,
  broker_pnl_synced_at: true,
  broker_position_id: true,
  broker_realized_synced_at: true,
  broker_unrealized_pnl: true,
  closed_at: true,
  created_at: true,
  current_price: true,
  entry_price: true,
  entry_reason: true,
  exit_price: true,
  exit_reason: true,
  id: true,
  initial_stop_loss_price: true,
  notional_value: true,
  opened_at: true,
  quantity: true,
  realized_pnl: true,
  side: true,
  status: true,
  stop_loss_price: true,
  take_profit_price: true,
  ticker: true,
  unrealized_pnl: true,
  updated_at: true,
  user_id: true,
};
const ACTIVITY_LOG_COLUMNS: Record<keyof Tables<"activity_log">, true> = {
  algorithm_id: true,
  created_at: true,
  details: true,
  event_type: true,
  id: true,
  position_id: true,
  ticker: true,
  user_id: true,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("E0 stub: network")))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A table's derived rules in brief: the DEFAULTs as written, the NOT NULL columns, the CHECK names, the trigger. */
function rules(table: string): Row {
  const t = deriveTables().get(table);
  if (!t) throw new Error(`no rules derived for ${table}`);
  const columns = [...t.columns];
  return {
    columns: columns.map(([name]) => name).sort(),
    defaults: Object.fromEntries(
      columns.flatMap(([n, c]) => (c.default ? [[n, c.default.sql] as const] : []))
    ),
    notNull: columns.filter(([, c]) => c.notNull).map(([name]) => name),
    checks: [...t.checks.keys()].sort(),
    updatedAtTrigger: t.updatedAtTrigger,
  };
}

const probe = (sql: string) => [...readMigrations(), { file: "99999_probe.sql", sql }];

describe("E0: the stub's rules are the migrations'", () => {
  it("derives the generated types' columns, no more and no fewer", () => {
    expect(rules("paper_positions").columns).toEqual(Object.keys(PAPER_POSITION_COLUMNS).sort());
    expect(rules("activity_log").columns).toEqual(Object.keys(ACTIVITY_LOG_COLUMNS).sort());
  });

  it("derives the defaults, NOT NULLs and CHECKs #352 copied by hand, and the updated_at trigger", () => {
    expect(rules("paper_positions")).toMatchObject({
      defaults: {
        id: "gen_random_uuid()",
        side: "'long'",
        opened_at: "now()",
        unrealized_pnl: "0",
        entry_reason: "'{}'",
        status: "'open'",
        created_at: "now()",
        updated_at: "now()",
      },
      notNull: [
        "id",
        "user_id",
        "algorithm_id",
        "ticker",
        "side",
        "quantity",
        "notional_value",
        "entry_price",
        "opened_at",
        "entry_reason",
        "status",
      ],
      checks: [
        "paper_positions_entry_price_check",
        "paper_positions_exit_reason_check",
        "paper_positions_notional_value_check",
        "paper_positions_quantity_check",
        "paper_positions_side_check",
        "paper_positions_status_check",
      ],
      updatedAtTrigger: true,
    });
    expect(rules("activity_log")).toMatchObject({
      defaults: { id: "gen_random_uuid()", details: "'{}'", created_at: "now()" },
      notNull: ["id", "user_id", "event_type"],
      checks: ["activity_log_event_type_check"],
      updatedAtTrigger: false,
    });
  });

  it("follows a later migration: its CHECK is enforced with no change to the stub", () => {
    const sql =
      "alter table public.paper_positions add constraint paper_positions_quantity_cap check (quantity <= 1000);";
    const cap = deriveTables(probe(sql))
      .get("paper_positions")
      ?.checks.get("paper_positions_quantity_cap");
    expect([1000, 1001, null].map((quantity) => cap?.holds({ quantity }))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it.each([
    "alter table public.paper_positions alter column side set default 'short'",
    "alter table public.paper_positions rename column ticker to symbol",
    "alter table public.activity_log add column tags text[] default array[]::text[]",
    "alter table public.paper_positions add constraint paper_positions_size check (quantity * entry_price < 1e9)",
    "create unique index paper_positions_one_open on public.paper_positions (algorithm_id)",
    "create trigger audit after insert on public.paper_positions for each row execute function audit()",
    "drop table public.activity_log",
  ])("throws on a statement it cannot read, naming the migration: %s", (sql) => {
    expect(() => deriveTables(probe(`${sql};`))).toThrow(
      /^99999_probe\.sql: the E0 database stub cannot read/
    );
  });
});

describe("E0: the stub stores, records and hands out separate JSON copies", () => {
  it("stores a payload as JSON: an undefined key dropped, NaN as null, later changes to it not seen", async () => {
    const db = new FakeDatabase();
    const reason = { note: "a", skip: undefined };
    const sent = {
      ...POSITION,
      current_price: Number.NaN,
      exit_reason: undefined,
      entry_reason: reason,
    };
    await db.client().from("paper_positions").insert(sent);
    reason.note = "changed";
    const [stored] = db.rows("paper_positions");
    expect(stored).not.toHaveProperty("exit_reason");
    expect(stored.current_price).toBeNull();
    expect(stored.entry_reason).toStrictEqual({ note: "a" });
  });

  it("hands out copies: changing a returned row, a read or a write record changes nothing stored", async () => {
    const db = new FakeDatabase();
    const client = db.client();
    const returned = await client.from("paper_positions").insert(POSITION).select().single();
    (returned.data as Row).ticker = "EUR/USD";
    db.writes[0].rows[0].ticker = "GBP/USD";
    const read = await client.from("paper_positions").select("*");
    (read.data as Row[])[0].ticker = "USD/JPY";
    expect(db.rows("paper_positions")[0].ticker).toBe("XAU/USD");
  });

  it("reads every column, NULL where the row has nothing", async () => {
    const db = new FakeDatabase({ paper_positions: [POSITION] });
    const data = (await db.client().from("paper_positions").select("*").single()).data as Row;
    expect(Object.keys(data).sort()).toEqual(Object.keys(PAPER_POSITION_COLUMNS).sort());
    expect(data.closed_at).toBeNull();
  });

  it("runs the updated_at trigger on an update, over the value the update sets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-06T10:00:00.000Z"));
    const db = new FakeDatabase({ paper_positions: [POSITION] });
    vi.setSystemTime(new Date("2026-01-06T14:00:00.000Z"));
    const stale = { status: "closed", updated_at: "1999-01-01T00:00:00.000Z" };
    await db.client().from("paper_positions").update(stale).eq("ticker", "XAU/USD");
    const [row] = db.rows("paper_positions");
    expect([row.created_at, row.updated_at, row.status]).toEqual([
      "2026-01-06T10:00:00.000Z",
      "2026-01-06T14:00:00.000Z",
      "closed",
    ]);
  });

  it("applies the defaults and the refusals to seed rows", () => {
    const db = new FakeDatabase({ paper_positions: [POSITION] });
    expect(db.rows("paper_positions")[0]).toMatchObject({ status: "open", unrealized_pnl: 0 });
    expect(() => new FakeDatabase({ paper_positions: [{ ...POSITION, opened_at: null }] })).toThrow(
      /refused: null value in column "opened_at"/
    );
  });
});

describe("E0: the stub's filters treat NULL as SQL does", () => {
  it("eq, neq and in never match NULL; is(null) does", async () => {
    const closed = { ...POSITION, ticker: "EUR/USD", exit_reason: "manual" };
    const db = new FakeDatabase({ paper_positions: [POSITION, closed] });
    const select = () => db.client().from("paper_positions").select("*");
    const tickers = async (q: PromiseLike<{ data: unknown }>) =>
      ((await q).data as Row[]).map((r) => r.ticker);
    expect(await tickers(select().eq("exit_reason", null as unknown as string))).toEqual([]);
    expect(await tickers(select().neq("exit_reason", "manual"))).toEqual([]);
    expect(await tickers(select().in("exit_reason", ["manual"]))).toEqual(["EUR/USD"]);
    expect(await tickers(select().is("exit_reason", null))).toEqual(["XAU/USD"]);
  });
});

describe("E0: the stub records every call it does not support", () => {
  it("an unknown client property, an unknown method and rpc, even where the throw is caught", () => {
    const db = new FakeDatabase();
    const client = db.client();
    expect(client.auth).toBeTypeOf("function");
    expect(() => client.from("activity_log").select("*").textSearch("details", "x")).toThrow(
      /not supported/
    );
    expect(() => client.rpc("last_scan_tick")).toThrow(/not stubbed/);
    expect(db.unsupported.splice(0)).toEqual([
      "client.auth",
      'from("activity_log").textSearch',
      'rpc("last_scan_tick")',
    ]);
  });

  it("upsert, a second order(), a count without head and single() over several rows", async () => {
    const db = new FakeDatabase({
      paper_positions: [POSITION, { ...POSITION, ticker: "EUR/USD" }],
    });
    const from = () => db.client().from("paper_positions");
    await from().upsert({ ...POSITION, ticker: "GBP/USD" });
    await from().select("*").order("ticker").order("opened_at");
    await from().select("*", { count: "exact" });
    await from().update({ status: "closed" }).eq("user_id", USER).select().single();
    expect(db.unsupported.splice(0)).toEqual([
      'from("paper_positions") upsert(), which the stub stores as an insert',
      'from("paper_positions") a second order(), which replaces the first',
      'from("paper_positions") select() with a count but no head',
      'from("paper_positions") single() over 3 rows',
    ]);
  });
});
