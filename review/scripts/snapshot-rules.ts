/**
 * Takes the rules snapshot the review harness reads (lib/rules-snapshot.ts):
 * the five deployed rows and the four harness-source rows, exactly as the
 * database returns them, each with a sha-256 of its rules. Read-only. Refuses
 * unless the five deployed rows are all status='active' and no other row is,
 * because otherwise the kill switch's re-test may be running.
 * Reproduce: pnpm exec tsx review/scripts/snapshot-rules.ts
 */
import { writeFileSync } from "node:fs";
import { readOnlySupabase } from "./lib/env";
import { ACTIVE, HARNESS_SOURCE } from "./lib/harness";
import {
  RULES_SNAPSHOT,
  rulesSha256,
  type RulesSnapshot,
  type SnapshotRow,
} from "./lib/rules-snapshot";
import type { AlgorithmRules } from "../../src/types/algorithm";

const DEPLOYED: string[] = ACTIVE.map((a) => a.id);
const IDS: string[] = [
  ...DEPLOYED,
  ...HARNESS_SOURCE.trio.map((t) => t.id),
  HARNESS_SOURCE.engulfingSearch.id,
];

async function activeCheck(): Promise<RulesSnapshot["check"]> {
  const { data, error } = await readOnlySupabase()
    .from("algorithms")
    .select("id")
    .eq("status", "active");
  if (error) {
    throw new Error(error.message);
  }
  const activeIds = data.map((r) => r.id).sort();
  return {
    active_ids: activeIds,
    deployed_all_active: DEPLOYED.every((id) => activeIds.includes(id)),
    other_active: activeIds.filter((id) => !DEPLOYED.includes(id)).length,
  };
}

async function readRows(): Promise<SnapshotRow[]> {
  const { data, error } = await readOnlySupabase()
    .from("algorithms")
    .select("id, name, status, updated_at, rules")
    .in("id", IDS);
  if (error) {
    throw new Error(error.message);
  }
  return IDS.map((id) => {
    const r = data.find((x) => x.id === id);
    if (!r) {
      throw new Error(`no algorithm row ${id}`);
    }
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      updated_at: r.updated_at,
      rules: r.rules as unknown as AlgorithmRules,
      rules_sha256: rulesSha256(r.rules),
    };
  });
}

async function main(): Promise<void> {
  const check = await activeCheck();
  if (!check.deployed_all_active || check.other_active > 0) {
    throw new Error(`refusing: active rows are ${check.active_ids.join(", ")}`);
  }
  const snap: RulesSnapshot = {
    taken_at: new Date().toISOString(),
    source: "algorithms table, read-only, through the review harness's Supabase client",
    check,
    rows: await readRows(),
  };
  writeFileSync(RULES_SNAPSHOT, `${JSON.stringify(snap, null, 2)}\n`);
  for (const r of snap.rows) {
    process.stdout.write(`${r.status.padEnd(9)} ${r.rules_sha256.slice(0, 12)} ${r.name}\n`);
  }
  process.stdout.write(`→ ${RULES_SNAPSHOT}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
