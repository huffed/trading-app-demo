/**
 * An in-memory stand-in for the Supabase client, for E0's live-path tests (decision 0014). Tables are arrays of rows,
 * seeded by the test. Every read and write is recorded. A write to paper_positions or activity_log is checked as
 * PostgREST and Postgres would check it (./db-checks.ts): an unknown column, then a NULL in a NOT NULL column once the
 * column defaults are applied, then a broken CHECK. A refused write gets their error code, and the engine sees only
 * the `{ error }` it already ignores in places (docs/DEBT.md D-04). As in supabase-js v2, a write returns rows only
 * when `.select()` is chained. A query method this stub does not implement is a TypeError. The stub's known gaps are
 * docs/DEBT.md D-47.
 */
import { columnDefaults, refusal, unknownColumn } from "./db-checks";
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

/** The payload as PostgREST receives it: JSON drops a key whose value is undefined, so its default applies. */
function defined(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

const PREDICATES: Record<Filter["op"], (v: unknown, want: unknown) => boolean> = {
  eq: (v, want) => v === want || (want === null && v === undefined),
  is: (v, want) => v === want || (want === null && v === undefined),
  neq: (v, want) => v !== want,
  in: (v, want) => Array.isArray(want) && want.includes(v),
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

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(
        table,
        rows.map((r) => ({ ...r }))
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
      from: (table: string): Query => new Query(this, table),
      rpc: (fn: string): never => {
        throw new Error(`E0 stub: rpc ${fn} is not stubbed`);
      },
    };
    return api as unknown as SupabaseClient;
  }
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
    return this;
  }
  insert(rows: Row | Row[]): this {
    return this.write("insert", rows);
  }
  upsert(rows: Row | Row[]): this {
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
    this.payload = (Array.isArray(rows) ? rows : [rows]).map(defined);
    return this;
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
      return this.shape(this.selected());
    }
    return this.op === "delete" ? this.remove() : this.change();
  }

  private change(): Result {
    const now = new Date().toISOString();
    const rows =
      this.op === "update"
        ? this.selected().map((r) => ({ ...r, ...this.payload[0] }))
        : this.payload.map((r) => ({ ...columnDefaults(this.table, now), ...r }));
    const error =
      unknownColumn(this.table, this.payload) ??
      rows.map((r) => refusal(this.table, r)).find((e) => e !== null) ??
      null;
    this.db.writes.push({ table: this.table, op: this.op as WriteOp, rows, error });
    if (error) return { data: null, error };
    if (this.op === "update") {
      for (const r of this.selected()) Object.assign(r, this.payload[0]);
    } else {
      this.db.rows(this.table).push(...rows);
    }
    return this.returned(rows);
  }

  private remove(): Result {
    const doomed = this.selected();
    const gone = new Set(doomed);
    this.db.tables.set(
      this.table,
      this.db.rows(this.table).filter((r) => !gone.has(r))
    );
    this.db.writes.push({ table: this.table, op: "delete", rows: doomed, error: null });
    return this.returned(doomed);
  }

  /** supabase-js v2 returns a write's rows only when `.select()` is chained after it. */
  private returned(rows: Row[]): Result {
    return this.returning ? this.shape(rows) : { data: null, error: null };
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
