/**
 * The committed snapshot of the algorithm rows the review scripts read: the
 * five deployed rows and the four harness-source rows. The harness reads rules
 * from it by default, so every review number stays reproducible after the live
 * rules change; QT_REVIEW_RULES=live reads the database instead. Each row's
 * rules carry a sha-256 that is re-checked on load.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AlgorithmRules } from "../../../src/types/algorithm";

export const RULES_SNAPSHOT = "review/inputs/deployed-rules-2026-11-21.json";

export interface SnapshotRow {
  id: string;
  name: string;
  status: string;
  updated_at: string | null;
  rules: AlgorithmRules;
  rules_sha256: string;
}

export interface RulesSnapshot {
  taken_at: string;
  source: string;
  check: { active_ids: string[]; deployed_all_active: boolean; other_active: number };
  rows: SnapshotRow[];
}

export function rulesSha256(rules: unknown): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

let cache: Map<string, SnapshotRow> | null = null;

function load(): Map<string, SnapshotRow> {
  if (cache) {
    return cache;
  }
  const text = readFileSync(resolve(process.cwd(), RULES_SNAPSHOT), "utf-8");
  const snap = JSON.parse(text) as RulesSnapshot;
  const rows = new Map<string, SnapshotRow>();
  for (const row of snap.rows) {
    if (rulesSha256(row.rules) !== row.rules_sha256) {
      throw new Error(`${RULES_SNAPSHOT}: the rules of ${row.id} do not match their sha-256`);
    }
    rows.set(row.id, row);
  }
  cache = rows;
  return rows;
}

export function readsLiveRules(): boolean {
  return process.env.QT_REVIEW_RULES === "live";
}

export function snapshotRules(id: string): { rules: AlgorithmRules; name: string } {
  const row = load().get(id);
  if (!row) {
    throw new Error(`${RULES_SNAPSHOT}: no row ${id}`);
  }
  return { rules: row.rules, name: row.name };
}
