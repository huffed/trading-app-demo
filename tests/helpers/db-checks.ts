/**
 * The values a CHECK constraint accepts, read from supabase/migrations/. Generated types cannot see these lists, so
 * the contract test (tests/contracts/db-check-constraints.test.ts) and E0's database stub (./fake-supabase.ts) parse
 * the newest migration that defines each constraint.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
