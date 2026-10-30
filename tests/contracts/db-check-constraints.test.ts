/**
 * Contract — the strings the engine writes must be accepted by the database.
 *
 * `paper_positions.exit_reason` and `activity_log.event_type` are `string`
 * columns guarded by CHECK constraints in supabase/migrations/. Generated
 * types cannot see the lists, so this test parses the newest migration that
 * defines each constraint and compares it with what the code writes.
 * Today three exit reasons and four event types are rejected (audit A4;
 * docs/DEBT.md D-01); draft PR #291 (migration 00053) widens both lists.
 * The `it.fails` cases flip to "expected to fail but passed" when it lands.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** Values of the newest `add constraint <name> check (... in (...))` in the migrations folder. */
function checkListFor(constraint: string): string[] {
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

/** Every `event_type: "<literal>"` the application code writes. */
function eventTypeLiteralsInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/event_type:\s*"([a-z_]+)"/g)) {
          const sites = found.get(m[1]) ?? [];
          sites.push(full.replace(`${ROOT}/`, ""));
          found.set(m[1], sites);
        }
      }
    }
  };
  walk(join(ROOT, "src", "lib"));
  walk(join(ROOT, "src", "app", "api"));
  return found;
}

/** Exit reasons written through variables, so a literal scan cannot see them. */
const EXIT_REASONS_WRITTEN = {
  stop_loss: "src/lib/scan/exit-trigger.ts",
  take_profit: "src/lib/scan/exit-trigger.ts",
  exit_signal: "src/lib/scan/exit-trigger.ts",
  manual: "src/app/api/admin/flatten-algo/route.ts",
  stagnant_exit: "src/lib/scan/engine-position-mgmt.ts:93",
  daily_loss_halt: "src/lib/scan/daily-halt.ts:97-101 → flatten.ts",
  portfolio_halt: "src/lib/scan/portfolio-halt.ts:127 → flatten.ts",
  broker_rejected: "src/lib/scan/live-execution.ts:262",
} as const;

/** Event types emitted through a variable or a ternary (not a literal field). */
const EVENT_TYPES_WRITTEN_INDIRECTLY = {
  stop_loss_hit: "src/lib/scan/engine-position-mgmt.ts:190",
  take_profit_hit: "src/lib/scan/engine-position-mgmt.ts:191",
  live_order_closed: "src/lib/scan/flatten.ts:122-127",
  live_order_close_failed: "src/lib/scan/flatten.ts:122-127",
  drift_warn: "src/lib/scan/engine.ts:260",
  drift_halt: "src/lib/scan/engine.ts:260",
} as const;

describe("paper_positions.exit_reason CHECK vs the engine", () => {
  const accepted = new Set(checkListFor("paper_positions_exit_reason_check"));

  it("the constraint was found in the migrations", () => {
    expect(accepted.size).toBeGreaterThan(0);
  });

  it("the values accepted today are the six from migration 00038", () => {
    expect([...accepted].sort()).toEqual(
      [
        "broker_rejected",
        "exit_signal",
        "manual",
        "stagnant_no_excursion",
        "stop_loss",
        "take_profit",
      ].sort()
    );
  });

  for (const [reason, site] of Object.entries(EXIT_REASONS_WRITTEN)) {
    const known = ["stagnant_exit", "daily_loss_halt", "portfolio_halt"].includes(reason);
    (known ? it.fails : it)(`${reason} (written at ${site}) is accepted by the CHECK`, () => {
      expect(accepted.has(reason)).toBe(true);
    });
  }
});

describe("activity_log.event_type CHECK vs the engine", () => {
  const accepted = new Set(checkListFor("activity_log_event_type_check"));
  const literals = eventTypeLiteralsInSource();

  it("the constraint was found in the migrations and the source scan found emitters", () => {
    expect(accepted.size).toBeGreaterThan(20);
    expect(literals.size).toBeGreaterThan(10);
  });

  for (const [eventType, sites] of [...literals.entries()].sort()) {
    const known = ["dll_warning", "broker_realized_synced"].includes(eventType);
    (known ? it.fails : it)(
      `literal ${eventType} (${sites.join(", ")}) is accepted by the CHECK`,
      () => {
        expect(accepted.has(eventType)).toBe(true);
      }
    );
  }

  for (const [eventType, site] of Object.entries(EVENT_TYPES_WRITTEN_INDIRECTLY)) {
    const known = ["live_order_close_failed", "drift_warn"].includes(eventType);
    (known ? it.fails : it)(
      `${eventType} (via a variable at ${site}) is accepted by the CHECK`,
      () => {
        expect(accepted.has(eventType)).toBe(true);
      }
    );
  }
});
