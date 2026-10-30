/**
 * DB CHECK-constraint contract (review 2026-10-28, safety fix).
 *
 * The live database enforces CHECK constraints on `paper_positions.exit_reason`
 * and `activity_log.event_type`. Until migration 00053 the code wrote values
 * the constraints rejected ('stagnant_exit', 'daily_loss_halt',
 * 'portfolio_halt'; 'dll_warning', 'broker_realized_synced',
 * 'live_order_close_failed'), so a stagnant exit could never be recorded and
 * a daily-loss / portfolio halt flatten would fail silently.
 *
 * This test pins the contract from both ends:
 *   1. every value in the TypeScript source-of-truth arrays is allowed by the
 *      LATEST migration that (re)defines each constraint;
 *   2. every string literal the code writes for those columns is a member of
 *      the TypeScript arrays (so a new literal cannot slip in unnoticed);
 *   3. the three exit paths named in the review are explicitly covered.
 *
 * It reads the migration files from disk; vitest runs with cwd = repo root.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVITY_EVENT_TYPES } from "@/types/activity";
import { EXIT_REASONS } from "@/types/position";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const SRC_DIR = join(ROOT, "src");

/** Values allowed by the LAST `add constraint <name> check (...)` in migration order. */
function latestCheckValues(constraint: string): { file: string; values: Set<string> } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: { file: string; values: Set<string> } | null = null;
  const re = new RegExp(`add\\s+constraint\\s+${constraint}\\s+check\\s*\\(([\\s\\S]*?)\\);`, "gi");
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const m of sql.matchAll(re)) {
      const values = new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
      found = { file: f, values };
    }
  }
  if (!found) throw new Error(`no migration defines constraint ${constraint}`);
  return found;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkTs(p, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      name !== "database.types.ts"
    ) {
      out.push(p);
    }
  }
  return out;
}

/** String literals the production code writes to the two columns. Scoped to
 *  the directories that perform writes; UI filter strings are excluded. */
function writtenLiterals(): { exit: Map<string, string[]>; event: Map<string, string[]> } {
  const exit = new Map<string, string[]>();
  const event = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, value: string, file: string) => {
    const list = map.get(value) ?? [];
    list.push(file.replace(ROOT + "/", ""));
    map.set(value, list);
  };
  const dirs = [
    join(SRC_DIR, "lib", "scan"),
    join(SRC_DIR, "lib", "cohort"),
    join(SRC_DIR, "app", "api"),
  ];
  for (const dir of dirs) {
    for (const file of walkTs(dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/exit_reason:\s*"([a-z_]+)"/g)) add(exit, m[1], file);
      for (const m of src.matchAll(/exitReason\s*=\s*"([a-z_]+)"/g)) add(exit, m[1], file);
      for (const m of src.matchAll(/flattenAlgorithmPositions\([^)]*?"([a-z_]+)"\s*\)/gs))
        add(exit, m[1], file);
      for (const m of src.matchAll(/\?\s*"(stagnant_exit)"/g)) add(exit, m[1], file);
      for (const m of src.matchAll(/event_type:\s*"([a-z_]+)"/g)) add(event, m[1], file);
      for (const m of src.matchAll(/eventType\s*=\s*"([a-z_]+)"/g)) add(event, m[1], file);
      // Ternary event types: `event_type:\n  cond ? "a" : cond2 ? "b" : "c",`
      for (const m of src.matchAll(/event_type:\s*\n([\s\S]*?),\n/g)) {
        for (const q of m[1].matchAll(/"([a-z_]+)"/g)) add(event, q[1], file);
      }
    }
  }
  return { exit, event };
}

describe("DB CHECK contract — paper_positions.exit_reason", () => {
  const { file, values } = latestCheckValues("paper_positions_exit_reason_check");

  it("the latest migration is 00053 or later (the widening landed)", () => {
    expect(file >= "00053").toBe(true);
  });

  it("every EXIT_REASONS value is allowed by the DB", () => {
    for (const v of EXIT_REASONS) {
      expect(values, `${v} missing from ${file}`).toContain(v);
    }
  });

  it("regression: the stagnant exit and both halt flattens write allowed values", () => {
    // engine-position-mgmt.ts (E2.25.f canonical spelling)
    expect(values).toContain("stagnant_exit");
    // daily-halt.ts → flattenAlgorithmPositions(..., "daily_loss_halt")
    expect(values).toContain("daily_loss_halt");
    // portfolio-halt.ts → flattenAlgorithmPositions(..., "portfolio_halt")
    expect(values).toContain("portfolio_halt");
    // legacy spelling kept for historical rows
    expect(values).toContain("stagnant_no_excursion");
  });

  it("every exit_reason literal the code writes is in EXIT_REASONS", () => {
    const { exit } = writtenLiterals();
    expect(exit.size).toBeGreaterThanOrEqual(6);
    for (const [v, files] of exit) {
      expect(EXIT_REASONS as readonly string[], `${v} written in ${files.join(", ")}`).toContain(v);
    }
  });
});

describe("DB CHECK contract — activity_log.event_type", () => {
  const { file, values } = latestCheckValues("activity_log_event_type_check");

  it("every ACTIVITY_EVENT_TYPES value is allowed by the DB", () => {
    for (const v of ACTIVITY_EVENT_TYPES) {
      expect(values, `${v} missing from ${file}`).toContain(v);
    }
  });

  it("regression: the three event types that were being dropped are allowed", () => {
    expect(values).toContain("dll_warning"); // daily-halt.ts
    expect(values).toContain("broker_realized_synced"); // broker-truth-sync.ts
    expect(values).toContain("live_order_close_failed"); // flatten.ts
  });

  it("every event_type literal the code writes is in ACTIVITY_EVENT_TYPES", () => {
    const { event } = writtenLiterals();
    expect(event.size).toBeGreaterThanOrEqual(15);
    for (const [v, files] of event) {
      expect(
        ACTIVITY_EVENT_TYPES as readonly string[],
        `${v} written in ${files.join(", ")}`
      ).toContain(v);
    }
  });
});
