/**
 * PostgREST's filters as E0's database stub (./fake-supabase.ts) applies them to a row: `eq`, `neq`, `gt`, `gte`,
 * `lt`, `lte`, `in` and `is`, each negated by `.not()`, on a column or on `<embedded table>.<column>`. As in SQL, a
 * comparison never matches NULL, and a missing column reads as NULL.
 */
import type { Row } from "./db-checks";

export interface Filter {
  /** A column, or `<embedded table>.<column>`. */
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is";
  value: unknown;
  /** `.not()`: true where the operator does not hold, NULL excepted as in SQL (`not is null` aside). */
  negate?: boolean;
}

export function compare(a: unknown, b: unknown): number {
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

/** A column's value, or an embedded row's column's value for `<table>.<column>`. */
function valueAt(row: Row, column: string): unknown {
  const dot = column.indexOf(".");
  if (dot < 0) return row[column];
  const embedded = row[column.slice(0, dot)];
  return embedded && typeof embedded === "object"
    ? (embedded as Row)[column.slice(dot + 1)]
    : undefined;
}

export function matches(row: Row, f: Filter): boolean {
  const v = valueAt(row, f.column);
  const hit = PREDICATES[f.op](v, f.value);
  if (!f.negate) return hit;
  return f.op === "is" ? !hit : v != null && !hit;
}

/** Whether `op` is a filter operator the stub applies. */
export function isOperator(op: string): op is Filter["op"] {
  return op in PREDICATES;
}
