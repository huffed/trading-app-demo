/**
 * What the database refuses and fills in, for the contract test (tests/contracts/db-check-constraints.test.ts) and
 * E0's database stub (./fake-supabase.ts). The values a named CHECK accepts are read from supabase/migrations/, since
 * generated types cannot see them: the newest migration that defines each constraint wins. The columns, NOT NULLs,
 * DEFAULTs, CHECKs and updated_at trigger of paper_positions and activity_log are derived from the migrations
 * (./migration-schema.ts) on first use, so a migration changes the stub with it.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveTables } from "./migration-schema";
import type { DerivedTable } from "./migration-schema";

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

let derived: Map<string, DerivedTable> | null = null;

/** A table's rules from the migrations, read once; undefined for a table the stub does not check. */
function rulesOf(table: string): DerivedTable | undefined {
  derived ??= deriveTables();
  return derived.get(table);
}

/** PostgREST's refusal of a payload key that is not a column. */
export function unknownColumn(table: string, payload: Row[]): DbError | null {
  const columns = rulesOf(table)?.columns;
  const key = columns && payload.flatMap((r) => Object.keys(r)).find((k) => !columns.has(k));
  if (!key) return null;
  return {
    code: "PGRST204",
    message: `Could not find the '${key}' column of '${table}' in the schema cache`,
  };
}

/** Postgres's refusal of a row: NOT NULL first, in column order, then the CHECKs in alphabetical order of name. */
export function refusal(table: string, row: Row): DbError | null {
  const rules = rulesOf(table);
  if (!rules) return null;
  const missing = [...rules.columns].find(([name, c]) => c.notNull && row[name] == null)?.[0];
  if (missing) {
    return {
      code: "23502",
      message: `null value in column "${missing}" of relation "${table}" violates not-null constraint`,
    };
  }
  const checks = [...rules.checks.values()].sort((a, b) => (a.constraint < b.constraint ? -1 : 1));
  const broken = checks.find((c) => !c.holds(row));
  if (!broken) return null;
  return {
    code: "23514",
    message: `new row for relation "${table}" violates check constraint "${broken.constraint}"`,
  };
}

/** A new row's defaults: the migrations' for paper_positions and activity_log, else an id and a created_at. */
export function columnDefaults(table: string, now: string): Row {
  const rules = rulesOf(table);
  if (!rules) return { id: randomUUID(), created_at: now };
  const set = [...rules.columns].flatMap(([name, c]) =>
    c.default ? [[name, c.default.value(now)] as const] : []
  );
  return Object.fromEntries(set);
}

/** A stored row as a read returns it: a copy, with NULL in each of the table's columns it lacks. */
export function asRead(table: string, row: Row): Row {
  const columns = [...(rulesOf(table)?.columns.keys() ?? [])];
  return { ...Object.fromEntries(columns.map((c) => [c, null] as const)), ...structuredClone(row) };
}

/** Whether 00002's updated_at trigger sets the column on every update of the table. */
export function touchesUpdatedAt(table: string): boolean {
  return rulesOf(table)?.updatedAtTrigger ?? false;
}
