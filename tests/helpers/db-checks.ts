/**
 * What the database refuses and fills in, for the contract test (tests/contracts/db-check-constraints.test.ts) and
 * E0's database stub (./fake-supabase.ts). The values a named CHECK accepts are read from supabase/migrations/, since
 * generated types cannot see them: the newest migration that defines each constraint wins. The columns are typed
 * against the generated types; the defaults, NOT NULLs and column CHECKs of paper_positions and activity_log are
 * copied from supabase/migrations/00011 and 00012.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tables } from "@/lib/supabase/database.types";

export type Row = Record<string, unknown>;

export interface DbError {
  code: string;
  message: string;
}

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

/** Values of the newest `add constraint <name> check (... in (...))` in the migrations folder. */
export function checkListFor(constraint: string): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let list: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const re = new RegExp(`add constraint\\s+${constraint}[\\s\\S]*?in\\s*\\(([^)]*)\\)`, "i");
    const m = sql.match(re);
    if (m) list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return list;
}

type Table = "paper_positions" | "activity_log";
type Column<T extends Table> = keyof Tables<T> & string;
/** Every column of the generated Row type, so tsc fails when a migration adds or drops one and this map does not. */
type Columns<T extends Table> = Record<Column<T>, true>;

const PAPER_POSITION_COLUMNS: Columns<"paper_positions"> = {
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

const ACTIVITY_LOG_COLUMNS: Columns<"activity_log"> = {
  algorithm_id: true,
  created_at: true,
  details: true,
  event_type: true,
  id: true,
  position_id: true,
  ticker: true,
  user_id: true,
};

/** One table's rules, every column name checked against the generated types, so a misspelt one fails tsc. */
interface TableRules<T extends Table> {
  columns: Columns<T>;
  defaults: (now: string) => Partial<Record<Column<T>, unknown>>;
  notNull: readonly Column<T>[];
  checks: readonly { column: Column<T>; accepts: (v: unknown) => boolean }[];
}

interface Check {
  constraint: string;
  holds: (row: Row) => boolean;
}

interface TableSchema {
  columns: ReadonlySet<string>;
  defaults: (now: string) => Row;
  notNull: readonly string[];
  checks: readonly Check[];
}

/**
 * A table's schema. Each column CHECK goes under Postgres's name for it and passes a NULL, as in Postgres, which tests
 * a table's CHECKs in alphabetical order of name.
 */
function schema<T extends Table>(table: T, rules: TableRules<T>): [string, TableSchema] {
  const checks = rules.checks.map(({ column, accepts }) => ({
    constraint: `${table}_${column}_check`,
    holds: (row: Row) => row[column] == null || accepts(row[column]),
  }));
  return [
    table,
    {
      columns: new Set(Object.keys(rules.columns)),
      defaults: rules.defaults,
      notNull: rules.notNull,
      checks: checks.sort((a, b) => (a.constraint < b.constraint ? -1 : 1)),
    },
  ];
}

const positive = (v: unknown): boolean => Number(v) > 0;
const oneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    values.includes(String(v));

/** 00011 (paper_positions), 00012 (activity_log); the exit_reason and event_type lists are the newest migration's. */
const SCHEMA = new Map<string, TableSchema>([
  schema("paper_positions", {
    columns: PAPER_POSITION_COLUMNS,
    defaults: (now) => ({
      id: randomUUID(),
      side: "long",
      opened_at: now,
      unrealized_pnl: 0,
      entry_reason: {},
      status: "open",
      created_at: now,
      updated_at: now,
    }),
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
      { column: "side", accepts: oneOf(["long", "short"]) },
      { column: "quantity", accepts: positive },
      { column: "notional_value", accepts: positive },
      { column: "entry_price", accepts: positive },
      { column: "exit_reason", accepts: oneOf(checkListFor("paper_positions_exit_reason_check")) },
      { column: "status", accepts: oneOf(["open", "closed"]) },
    ],
  }),
  schema("activity_log", {
    columns: ACTIVITY_LOG_COLUMNS,
    defaults: (now) => ({ id: randomUUID(), details: {}, created_at: now }),
    notNull: ["id", "user_id", "event_type"],
    checks: [
      { column: "event_type", accepts: oneOf(checkListFor("activity_log_event_type_check")) },
    ],
  }),
]);

/** PostgREST's refusal of a payload key that is not a column. */
export function unknownColumn(table: string, payload: Row[]): DbError | null {
  const columns = SCHEMA.get(table)?.columns;
  const key = columns && payload.flatMap((r) => Object.keys(r)).find((k) => !columns.has(k));
  if (!key) return null;
  return {
    code: "PGRST204",
    message: `Could not find the '${key}' column of '${table}' in the schema cache`,
  };
}

/** Postgres's refusal of a row: NOT NULL first, then CHECK. */
export function refusal(table: string, row: Row): DbError | null {
  const schema = SCHEMA.get(table);
  const missing = schema?.notNull.find((c) => row[c] == null);
  if (missing) {
    return {
      code: "23502",
      message: `null value in column "${missing}" of relation "${table}" violates not-null constraint`,
    };
  }
  const broken = schema?.checks.find((c) => !c.holds(row));
  if (!broken) return null;
  return {
    code: "23514",
    message: `new row for relation "${table}" violates check constraint "${broken.constraint}"`,
  };
}

/** A new row's defaults: the migration's for paper_positions and activity_log, else an id and a created_at. */
export function columnDefaults(table: string, now: string): Row {
  return SCHEMA.get(table)?.defaults(now) ?? { id: randomUUID(), created_at: now };
}
