/**
 * An in-memory stand-in for the Supabase client, for E0's live-path tests (decision 0014). Tables are arrays of rows,
 * seeded by the test. Every read and write is recorded. A write to paper_positions or activity_log is checked as
 * PostgREST and Postgres would check it, by the rules the migrations leave (./db-checks.ts): an unknown column, then a
 * NULL in a NOT NULL column once the column defaults are applied, then a broken CHECK; an update runs the updated_at
 * trigger. A refused write gets their error code, and the engine sees only the `{ error }` it already ignores in
 * places (docs/DEBT.md D-04). Seed rows get the same defaults and checks. A payload is sent as JSON; what the stub
 * stores, records and hands out are separate copies, a read with NULL in each column a row lacks; and as in
 * supabase-js v2 a write returns rows only when `.select()` is chained.
 *
 * A call the stub does not support is recorded when it is made: an unknown method or client property (which also
 * throws), rpc, upsert, a second order(), a count without head, single() over several rows. After each test of a file
 * that imports this module, the record of every stub the test opened must be empty, so a call that an engine `catch`
 * swallows still fails the test. The stub's known gaps are docs/DEBT.md D-47.
 */
import { afterEach, expect } from "vitest";
import { asRead, columnDefaults, refusal, touchesUpdatedAt, unknownColumn } from "./db-checks";
import type { DbError, Row } from "./db-checks";
import type { SupabaseClient } from "@supabase/supabase-js";

export type { Row } from "./db-checks";
type WriteOp = "insert" | "update" | "upsert" | "delete";

interface Filter {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is";
  value: unknown;
}

export interface WriteRecord {
  table: string;
  op: WriteOp;
  rows: Row[];
  error: DbError | null;
}

interface Result {
  data: unknown;
  error: DbError | null;
  count?: number;
}

/** The stubs the running test opened. */
const opened: FakeDatabase[] = [];

afterEach(() => {
  const calls = opened.splice(0).flatMap((db) => db.unsupported);
  expect(calls, "calls the E0 database stub does not support (docs/DEBT.md D-47)").toEqual([]);
});

/**
 * The payload as PostgREST receives it, and a copy of it: JSON drops a key whose value is undefined, so its default
 * applies, and sends NaN and ±Infinity as null.
 */
function asSent(row: Row): Row {
  return JSON.parse(JSON.stringify(row)) as Row;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** As in SQL, `=`, `<>` and IN never match NULL; postgrest-js sends eq(…, null) as `eq.null`, a text comparison. */
const PREDICATES: Record<Filter["op"], (v: unknown, want: unknown) => boolean> = {
  eq: (v, want) => v != null && v === want,
  is: (v, want) => v === want || (want === null && v === undefined),
  neq: (v, want) => v != null && v !== want,
  in: (v, want) => v != null && Array.isArray(want) && want.includes(v),
  gt: (v, want) => v != null && compare(v, want) > 0,
  gte: (v, want) => v != null && compare(v, want) >= 0,
  lt: (v, want) => v != null && compare(v, want) < 0,
  lte: (v, want) => v != null && compare(v, want) <= 0,
};

function matches(row: Row, f: Filter): boolean {
  return PREDICATES[f.op](row[f.column], f.value);
}

export class FakeDatabase {
  readonly tables = new Map<string, Row[]>();
  readonly writes: WriteRecord[] = [];
  readonly reads: string[] = [];
  /** The calls the stub does not support, in the order they were made. */
  readonly unsupported: string[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    opened.push(this);
    const now = new Date().toISOString();
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(
        table,
        rows.map((r) => seeded(table, r, now))
      );
    }
  }

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  client(): SupabaseClient {
    const api = {
      from: (table: string): Query => this.guard(new Query(this, table), `from("${table}")`),
      rpc: (fn: string): never => {
        this.unsupported.push(`rpc("${fn}")`);
        throw new Error(`E0 stub: rpc ${fn} is not stubbed`);
      },
    };
    return this.guard(api, "client") as unknown as SupabaseClient;
  }

  /** `target`, with each property it lacks recorded when read and replaced by a function that throws. */
  private guard<T extends object>(target: T, path: string): T {
    return new Proxy(target, {
      get: (t, key, receiver): unknown => {
        if (typeof key === "symbol" || key in t) return Reflect.get(t, key, receiver);
        if (key === "then") return undefined;
        this.unsupported.push(`${path}.${key}`);
        return () => {
          throw new Error(`E0 stub: ${path}.${key} is not supported`);
        };
      },
    });
  }
}

/** A seed row as an insert would store it; a seed the database would refuse throws. */
function seeded(table: string, row: Row, now: string): Row {
  const stored = { ...columnDefaults(table, now), ...asSent(row) };
  const error = unknownColumn(table, [row]) ?? refusal(table, stored);
  if (error) throw new Error(`E0 stub: a ${table} seed row is refused: ${error.message}`);
  return stored;
}

class Query implements PromiseLike<Result> {
  private op: "select" | WriteOp = "select";
  private readonly filters: Filter[] = [];
  private payload: Row[] = [];
  private mode: "many" | "single" | "maybe" = "many";
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private headCount = false;
  private returning = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string
  ) {}

  select(_columns?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.op !== "select") this.returning = true;
    if (opts?.head) this.headCount = true;
    else if (opts?.count) this.unsupported("select() with a count but no head");
    return this;
  }
  insert(rows: Row | Row[]): this {
    return this.write("insert", rows);
  }
  upsert(rows: Row | Row[]): this {
    this.unsupported("upsert(), which the stub stores as an insert");
    return this.write("upsert", rows);
  }
  update(values: Row): this {
    return this.write("update", values);
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: unknown): this {
    return this.where(column, "eq", value);
  }
  neq(column: string, value: unknown): this {
    return this.where(column, "neq", value);
  }
  gt(column: string, value: unknown): this {
    return this.where(column, "gt", value);
  }
  gte(column: string, value: unknown): this {
    return this.where(column, "gte", value);
  }
  lt(column: string, value: unknown): this {
    return this.where(column, "lt", value);
  }
  lte(column: string, value: unknown): this {
    return this.where(column, "lte", value);
  }
  in(column: string, values: unknown[]): this {
    return this.where(column, "in", values);
  }
  is(column: string, value: unknown): this {
    return this.where(column, "is", value);
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    if (this.orderBy) this.unsupported("a second order(), which replaces the first");
    this.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybe";
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private write(op: WriteOp, rows: Row | Row[]): this {
    this.op = op;
    this.payload = (Array.isArray(rows) ? rows : [rows]).map(asSent);
    return this;
  }

  private unsupported(what: string): void {
    this.db.unsupported.push(`from("${this.table}") ${what}`);
  }

  private where(column: string, op: Filter["op"], value: unknown): this {
    this.filters.push({ column, op, value });
    return this;
  }

  private selected(): Row[] {
    let rows = this.db.rows(this.table).filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
    }
    return this.limitN === null ? rows : rows.slice(0, this.limitN);
  }

  private execute(): Result {
    if (this.op === "select") {
      this.db.reads.push(this.table);
      return this.shape(this.selected().map((r) => asRead(this.table, r)));
    }
    return this.op === "delete" ? this.remove() : this.change();
  }

  private change(): Result {
    const now = new Date().toISOString();
    const set = this.op === "update" ? this.updateSet(now) : {};
    const rows =
      this.op === "update"
        ? this.selected().map((r) => ({ ...r, ...set }))
        : this.payload.map((r) => ({ ...columnDefaults(this.table, now), ...r }));
    const error =
      unknownColumn(this.table, this.payload) ??
      rows.map((r) => refusal(this.table, r)).find((e) => e !== null) ??
      null;
    const record = rows.map((r) => structuredClone(r));
    this.db.writes.push({ table: this.table, op: this.op as WriteOp, rows: record, error });
    if (error) return { data: null, error };
    if (this.mode !== "many" && rows.length > 1) {
      this.unsupported(`single() over ${String(rows.length)} rows`);
    }
    this.store(rows, set);
    return this.returned(rows);
  }

  /** An update's SET, and the updated_at trigger's column where the table has the trigger. */
  private updateSet(now: string): Row {
    return touchesUpdatedAt(this.table)
      ? { ...this.payload[0], updated_at: now }
      : { ...this.payload[0] };
  }

  private store(rows: Row[], set: Row): void {
    if (this.op === "update") {
      for (const r of this.selected()) Object.assign(r, set);
    } else {
      this.db.rows(this.table).push(...rows);
    }
  }

  private remove(): Result {
    const doomed = this.selected();
    const gone = new Set(doomed);
    this.db.tables.set(
      this.table,
      this.db.rows(this.table).filter((r) => !gone.has(r))
    );
    const record = doomed.map((r) => structuredClone(r));
    this.db.writes.push({ table: this.table, op: "delete", rows: record, error: null });
    return this.returned(doomed);
  }

  /** supabase-js v2 returns a write's rows only when `.select()` is chained after it. */
  private returned(rows: Row[]): Result {
    const copies = rows.map((r) => asRead(this.table, r));
    return this.returning ? this.shape(copies) : { data: null, error: null };
  }

  private shape(rows: Row[]): Result {
    if (this.headCount) return { data: null, error: null, count: rows.length };
    if (this.mode === "many") return { data: rows, error: null };
    if (rows.length === 1) return { data: rows[0], error: null };
    if (this.mode === "maybe" && rows.length === 0) return { data: null, error: null };
    return {
      data: null,
      error: { code: "PGRST116", message: `${String(rows.length)} rows for a single() read` },
    };
  }
}
