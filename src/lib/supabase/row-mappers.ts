/**
 * Row mappers — the ONE place where generated DB row types
 * (database.types.ts) are coerced into richer domain types.
 *
 * Why a funnel: jsonb columns come back as the structural `Json` type;
 * domain types (AlgorithmRules, EntryReason, TradingProfile, ...) are
 * intentionally richer. Scattering `as unknown as X` at every call site
 * hides where the trust boundary is. Every coercion goes through here so
 * (a) there is exactly one grep-able trust boundary, and (b) when we add
 * runtime validation (zod .parse) it lands in one file.
 *
 * These are TYPE-ONLY operations — no runtime transformation happens.
 */
import type { BrokerConnection } from "@/lib/brokers/types";
import type { Algorithm, AlgorithmRules, Strategy } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import type { Portfolio } from "@/types/portfolio";
import type { Database, Json, Tables, TablesUpdate } from "./database.types";

/** jsonb → domain shape. The single sanctioned `as unknown as` bridge. */
export function fromJson<T>(value: Json | null): T {
  return value as unknown as T;
}

/** domain shape → jsonb for inserts/updates. Type-only. */
export function toJson<T>(value: T): Json {
  return value as unknown as Json;
}

export function rulesFromRow(rules: Json | null): AlgorithmRules {
  return fromJson<AlgorithmRules>(rules);
}

export function algorithmFromRow(row: Tables<"algorithms">): Algorithm {
  return row as unknown as Algorithm;
}

export function algorithmsFromRows(rows: Tables<"algorithms">[]): Algorithm[] {
  return rows as unknown as Algorithm[];
}

export function strategyFromRow(row: Tables<"strategies">): Strategy {
  return row as unknown as Strategy;
}

export function strategiesFromRows(rows: Tables<"strategies">[]): Strategy[] {
  return rows as unknown as Strategy[];
}

export function paperPositionFromRow(row: Tables<"paper_positions">): PaperPosition {
  return row as unknown as PaperPosition;
}

export function portfolioFromRow(row: Tables<"portfolios">): Portfolio {
  return row as unknown as Portfolio;
}

export function portfoliosFromRows(rows: Tables<"portfolios">[]): Portfolio[] {
  return rows as unknown as Portfolio[];
}

/** Coerce a Supabase `broker_connections` row to the domain `BrokerConnection`
 *  shape. Removes the `connData as unknown as BrokerConnection` double-cast
 *  from caller sites (cron/reconcile-broker-positions, settings/broker-actions). */
export function brokerConnectionFromRow(
  row: Tables<"broker_connections">
): BrokerConnection {
  return row as unknown as BrokerConnection;
}

/** DB stores side as text; the domain is a closed union. Type-only —
 *  the app only ever writes "long" | "short". */
export function sideFromRow(side: string): "long" | "short" {
  return side as "long" | "short";
}

/** Zod-validated partial → typed update payload. Object.fromEntries erases
 *  key-level types; the values were validated upstream by the form schema. */
export function toUpdateRow<T extends keyof Database["public"]["Tables"]>(
  values: Record<string, unknown>
): TablesUpdate<T> {
  return values as unknown as TablesUpdate<T>;
}
