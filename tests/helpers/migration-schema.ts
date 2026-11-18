/**
 * The rules of paper_positions and activity_log as supabase/migrations/ leave them, for E0's database stub
 * (./fake-supabase.ts, through ./db-checks.ts): each column with its NOT NULL and DEFAULT, each CHECK under its
 * Postgres name, and whether 00002's updated_at trigger runs on an update. The migrations are read in file order.
 * Only the forms they use are read: CREATE TABLE, ALTER TABLE's ADD COLUMN, ADD CONSTRAINT … CHECK, DROP CONSTRAINT
 * and ENABLE ROW LEVEL SECURITY, and that trigger; DEFAULTs of gen_random_uuid(), now(), a number or a quoted literal;
 * CHECKs of IN lists, comparisons with a number and `x IS NULL OR …`. Any other statement that can change these rules
 * (another ALTER TABLE action or trigger, a unique index, DROP TABLE) or an expression outside those forms throws,
 * naming the migration, so a migration the stub cannot follow fails the E0 tests instead of going unseen. Indexes,
 * policies, grants, functions and data statements are left out: they change no rule the stub applies.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

export interface MigrationFile {
  file: string;
  sql: string;
}

export interface Column {
  notNull: boolean;
  /** The DEFAULT as written, and its value for a new row at `now`. */
  default: { sql: string; value: (now: string) => unknown } | null;
}

export interface Check {
  constraint: string;
  sql: string;
  holds: (row: Row) => boolean;
}

export interface DerivedTable {
  columns: Map<string, Column>;
  checks: Map<string, Check>;
  updatedAtTrigger: boolean;
}

type Tables = Map<string, DerivedTable>;

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const TABLE = String.raw`(?:public\.)?(paper_positions|activity_log)\b`;

export function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }));
}

/** Comments, quoted literals, dollar-quoted bodies, the statement end, and everything else. */
const TOKEN = /--[^\n]*|'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$|;|[^;'$-]+|[\s\S]/g;

/** The top-level statements, comments dropped and whitespace collapsed. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const [token] of sql.matchAll(TOKEN)) {
    if (token === ";") {
      out.push(current);
      current = "";
    } else if (!token.startsWith("--")) {
      current += token;
    }
  }
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim());
}

const DEPTH: Partial<Record<string, number>> = { "(": 1, ")": -1 };

/** Splits at the commas outside parentheses and quotes. */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const c of list) {
    if (c === "'") quoted = !quoted;
    if (!quoted) depth += DEPTH[c] ?? 0;
    if (c === "," && depth === 0 && !quoted) {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  return [...parts, current.trim()].filter(Boolean);
}

function cannot(where: string, what: string): never {
  throw new Error(
    `${where}: the E0 database stub cannot read ${what} (tests/helpers/migration-schema.ts)`
  );
}

function defaultValue(sql: string, where: string): (now: string) => unknown {
  if (/^gen_random_uuid\(\)$/i.test(sql)) return () => randomUUID();
  if (/^now\(\)$/i.test(sql)) return (now) => now;
  if (/^-?\d+(?:\.\d+)?$/.test(sql)) return () => Number(sql);
  const literal = /^'((?:[^']|'')*)'(?:::\w+)?$/.exec(sql);
  if (!literal) return cannot(where, `DEFAULT ${sql}`);
  const text = literal[1].replace(/''/g, "'");
  return /^[{[]/.test(text) ? () => JSON.parse(text) as unknown : () => text;
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "=": (a, b) => a === b,
  "<>": (a, b) => a !== b,
};

/** A CHECK as a predicate. A NULL column passes, as a CHECK whose result is NULL passes in Postgres. */
function predicate(sql: string, where: string): (row: Row) => boolean {
  const e = /^\((.*)\)$/.exec(sql)?.[1] ?? sql;
  const nullOr = /^(\w+) is null or (.+)$/i.exec(e);
  if (nullOr) {
    const rest = predicate(nullOr[2], where);
    return (row) => row[nullOr[1]] == null || rest(row);
  }
  const list = /^(\w+) in \(((?:'[^']*'(?:, ?)?)+)\)$/i.exec(e);
  if (list) {
    const values = [...list[2].matchAll(/'([^']*)'/g)].map((v) => v[1]);
    return (row) => row[list[1]] == null || values.includes(String(row[list[1]]));
  }
  const cmp = /^(\w+) (>=|<=|<>|>|<|=) (-?\d+(?:\.\d+)?)$/.exec(e);
  if (!cmp) return cannot(where, `CHECK ${sql}`);
  const [, column, op, bound] = cmp;
  return (row) => row[column] == null || COMPARE[op](Number(row[column]), Number(bound));
}

function addCheck(t: DerivedTable, constraint: string, sql: string, where: string): void {
  t.checks.set(constraint, { constraint, sql, holds: predicate(sql, where) });
}

/** One column clause: NOT NULL or PRIMARY KEY, NULL, DEFAULT, CHECK, or REFERENCES with its ON actions. */
const CLAUSE =
  /^(?:(primary key|not null)|null|default ('(?:[^']|'')*'(?:::\w+)?|\w+\(\)|-?\d+(?:\.\d+)?)|check ?(\((?:[^()']|'[^']*'|\((?:[^()']|'[^']*')*\))*\))|references [\w.]+ ?\([\w, ]*\)(?: on (?:delete|update) (?:cascade|restrict|no action|set null|set default))*) ?/i;

function addColumn(t: DerivedTable, table: string, def: string, where: string): void {
  const head = /^(\w+) (\w+(?:\[\])?) ?(.*)$/.exec(def);
  if (!head || /^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(head[1])) {
    return cannot(where, `"${def}" in ${table}`);
  }
  const [, name, , clauses] = head;
  const column: Column = { notNull: false, default: null };
  for (let rest = clauses; rest; ) {
    const m = CLAUSE.exec(rest) ?? cannot(where, `"${rest}" in ${table}.${name}`);
    if (m[1]) column.notNull = true;
    if (m[2]) column.default = { sql: m[2], value: defaultValue(m[2], where) };
    if (m[3]) addCheck(t, `${table}_${name}_check`, m[3], where);
    rest = rest.slice(m[0].length);
  }
  t.columns.set(name, column);
}

function createTable(tables: Tables, table: string, body: string, where: string): void {
  const t: DerivedTable = { columns: new Map(), checks: new Map(), updatedAtTrigger: false };
  for (const entry of topLevel(body)) {
    const named = /^constraint (\w+) check ?(\(.*\))$/i.exec(entry);
    if (named) addCheck(t, named[1], named[2], where);
    else addColumn(t, table, entry, where);
  }
  tables.set(table, t);
}

type Action = (t: DerivedTable, m: RegExpExecArray, table: string, where: string) => void;

/** ALTER TABLE's actions, each a pattern and what it does to the table. */
const ACTIONS: [RegExp, Action][] = [
  [
    /^add column (if not exists )?(\w+)(.*)$/i,
    (t, m, table, where) => {
      if (!(m[1] && t.columns.has(m[2]))) addColumn(t, table, m[2] + m[3], where);
    },
  ],
  [
    /^add constraint (\w+) check ?(\(.*\))$/i,
    (t, m, _table, where) => {
      addCheck(t, m[1], m[2], where);
    },
  ],
  [
    /^drop constraint (?:if exists )?(\w+)$/i,
    (t, m) => {
      t.checks.delete(m[1]);
    },
  ],
  [/^enable row level security$/i, () => undefined],
];

function alterTable(tables: Tables, table: string, actions: string, where: string): void {
  const t = tables.get(table) ?? cannot(where, `ALTER TABLE ${table} before its CREATE TABLE`);
  for (const action of topLevel(actions)) {
    const found = firstMatch(ACTIONS, action) ?? cannot(where, `ALTER TABLE ${table} ${action}`);
    found[1](t, found[0], table, where);
  }
}

function trigger(tables: Tables, table: string, rest: string, where: string): void {
  const t = tables.get(table) ?? cannot(where, `a trigger on ${table} before its CREATE TABLE`);
  const updatedAt =
    /^before update on \S+ for each row execute (?:function|procedure) (?:public\.)?update_updated_at\(\)$/i;
  if (!updatedAt.test(rest)) return cannot(where, `the trigger "${rest}"`);
  t.updatedAtTrigger = true;
}

type Statement = (tables: Tables, m: RegExpExecArray, where: string) => void;

/** The statements that can change a rule of either table, and what each does. */
const STATEMENTS: [RegExp, Statement][] = [
  [
    new RegExp(String.raw`^create table (?:if not exists )?${TABLE} ?\((.*)\)$`, "i"),
    (tables, m, where) => {
      createTable(tables, m[1], m[2], where);
    },
  ],
  [
    new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${TABLE} (.*)$`, "i"),
    (tables, m, where) => {
      alterTable(tables, m[1], m[2], where);
    },
  ],
  [
    new RegExp(String.raw`^create (?:or replace )?trigger \w+ (.*on ${TABLE} .*)$`, "i"),
    (tables, m, where) => {
      trigger(tables, m[2], m[1], where);
    },
  ],
  [
    new RegExp(
      String.raw`^(?:create unique index|drop table|create (?:or replace )?rule)\b.*\b${TABLE}`,
      "i"
    ),
    (_tables, m, where) => cannot(where, `"${m[0]}"`),
  ],
];

/** The first pattern that matches `text`, with its match. */
function firstMatch<F>(patterns: [RegExp, F][], text: string): [RegExpExecArray, F] | undefined {
  for (const [re, apply] of patterns) {
    const m = re.exec(text);
    if (m) return [m, apply];
  }
  return undefined;
}

/** Both tables' rules after every migration in `migrations`, in order. */
export function deriveTables(migrations: MigrationFile[] = readMigrations()): Tables {
  const tables: Tables = new Map();
  for (const { file, sql } of migrations) {
    for (const statement of statements(sql)) {
      const found = firstMatch(STATEMENTS, statement);
      if (found) found[1](tables, found[0], file);
    }
  }
  return tables;
}
