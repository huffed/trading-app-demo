/**
 * B.2.33 (Stage 3.2, 2026-06-20) — standalone pre-registration JSON validator.
 *
 * Loads + Zod-validates `scripts/canonical/preregistration.json` (or
 * `PREREG_PATH` override) WITHOUT running the full backtest pipeline.
 *
 * Why standalone: previously a typo in the prereg JSON crashed the entire
 * `validate-algo.ts` fleet run mid-flight. Now the operator can run THIS
 * script first (~50ms) to confirm the JSON is well-formed + Zod-valid +
 * not full of expired-but-still-listed entries, BEFORE committing to a
 * ~minutes-long PERSIST=1 run.
 *
 * Also subsumes the originally-filed Stage 4.7.1 quarterly audit utility —
 * adds expiry-distance + criteria-count + registration-type breakdown to
 * the per-entry render.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/validate-preregistration.ts
 *     # validates default path
 *   PREREG_PATH=/path/to/file.json pnpm dlx tsx scripts/canonical/validate-preregistration.ts
 *     # alternative file
 *   STRICT_EXPIRED=1 pnpm dlx tsx scripts/canonical/validate-preregistration.ts
 *     # exit 2 (not 0) if any entry is expired — useful for CI gating
 *
 * Exit codes:
 *   0 — clean: JSON parses, Zod-valid, no entries (or all entries valid; expired ones flagged)
 *   1 — JSON syntax error OR Zod schema validation failure
 *   2 — STRICT_EXPIRED=1 AND at least one entry expired
 */
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { loadPreregistrations, type PreregisteredCriteria } from "../../src/lib/stats/preregistration";

// Inline .env.local loader — mirrors validate-algo.ts pattern so the operator
// can run this script directly without env-prefix ceremony. The standalone
// validator doesn't actually need env vars (no Supabase access), but reading
// .env.local lets `PREREG_PATH` be set there if the operator prefers.
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // No .env.local — fine, no required env vars.
  }
}

const PREREG_PATH = resolvePath(process.env.PREREG_PATH ?? "scripts/canonical/preregistration.json");
const STRICT_EXPIRED = process.env.STRICT_EXPIRED === "1";
const WARN_DAYS = Math.max(1, Number(process.env.WARN_DAYS ?? 30));

function countCriteria(entry: PreregisteredCriteria): number {
  // Count of optional criteria fields actually set (i.e. not undefined).
  // The audit-mind operator wants to see "are any entries oddly thin
  // (e.g. only `min_total_return: 0` — that's a no-op constraint)?"
  const keys: (keyof PreregisteredCriteria)[] = [
    "min_total_return",
    "min_win_rate",
    "max_static_dd",
    "max_daily_dd",
    "min_mean_r_ci_lower",
    "max_bonferroni_p_value",
    "max_oos_r_delta_pct",
    "min_held_out_trades",
  ];
  let n = 0;
  for (const k of keys) if (entry[k] !== undefined) n++;
  return n;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function main(): void {
  console.log(`\n===== validate-preregistration @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Path:           ${PREREG_PATH}`);
  console.log(`STRICT_EXPIRED: ${STRICT_EXPIRED ? "ON (exit 2 if any expired)" : "OFF"}`);
  console.log(`WARN_DAYS:      ${WARN_DAYS}\n`);

  // loadPreregistrations throws on JSON-syntax + Zod-schema errors with
  // B.2.39 + B.2.45 focused messages. We let it propagate to main().catch.
  const preregs = loadPreregistrations(PREREG_PATH);
  const now = new Date();
  const entries = Object.entries(preregs);

  if (entries.length === 0) {
    console.log("(no entries — file is empty or missing)");
    console.log("\nResult: OK (no entries to validate).");
    return;
  }

  // Print per-entry breakdown
  console.log(`Found ${entries.length} entries:\n`);
  console.log("┌──────────────────────────────────────────────────┬─────────────────────────┬─────────────┬──────────────┬─────────┐");
  console.log("│ Algorithm                                        │ Registration type       │ Expires in  │ Status       │ #criteria│");
  console.log("├──────────────────────────────────────────────────┼─────────────────────────┼─────────────┼──────────────┼─────────┤");
  let expiredCount = 0;
  let expiringSoonCount = 0;
  const typeTally: Record<string, number> = {};
  for (const [name, entry] of entries) {
    const expires = new Date(entry.expires_at);
    const valid = !Number.isNaN(expires.getTime());
    const days = valid ? daysBetween(now, expires) : NaN;
    let status: string;
    if (!valid) status = "BAD DATE";
    else if (days < 0) { status = "EXPIRED"; expiredCount++; }
    else if (days < WARN_DAYS) { status = `EXPIRING SOON`; expiringSoonCount++; }
    else status = "ACTIVE";
    const expiresStr = valid ? (days < 0 ? `${-days}d ago` : `${days}d`) : "n/a";
    const crit = countCriteria(entry);
    typeTally[entry.registration_type] = (typeTally[entry.registration_type] ?? 0) + 1;
    console.log(
      `│ ${name.padEnd(48).slice(0, 48)} │ ${entry.registration_type.padEnd(23)} │ ${expiresStr.padEnd(11)} │ ${status.padEnd(12)} │ ${crit.toString().padStart(7)} │`
    );
  }
  console.log("└──────────────────────────────────────────────────┴─────────────────────────┴─────────────┴──────────────┴─────────┘");

  // Breakdown by registration_type
  console.log(`\nBy registration_type:`);
  for (const [type, count] of Object.entries(typeTally).sort()) {
    console.log(`  ${type.padEnd(25)} ${count}`);
  }
  console.log(`\nExpired:       ${expiredCount}`);
  console.log(`Expiring soon: ${expiringSoonCount} (within ${WARN_DAYS}d)`);

  // Highlight thin-criteria entries (single criterion = effectively no constraint).
  const thinEntries = entries.filter(([, e]) => countCriteria(e) <= 1);
  if (thinEntries.length > 0) {
    console.log(`\n⚠️  Thin-criteria entries (≤1 active criterion — likely accidental no-op):`);
    for (const [n] of thinEntries) console.log(`    - ${n}`);
  }

  // Summary + exit code
  if (expiredCount > 0) {
    console.log(`\n⚠️  ${expiredCount} entry/entries EXPIRED. ${STRICT_EXPIRED ? "STRICT_EXPIRED=1 → exiting 2." : "STRICT_EXPIRED off → exiting 0 (warning only). Re-register or remove."}`);
    if (STRICT_EXPIRED) process.exit(2);
  } else if (expiringSoonCount > 0) {
    console.log(`\n⏳  ${expiringSoonCount} entry/entries EXPIRING within ${WARN_DAYS}d. Plan to re-register or let lapse.`);
  } else {
    console.log(`\nResult: OK — schema valid, no expirations.`);
  }
}

try {
  main();
} catch (e) {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
