/**
 * Market-state gate type definitions — extracted from
 * `lib/algorithm/market-state-gate.ts` as part of CB.M4 (2026-06-19 EVE).
 * Runtime + checking logic stays in lib; only the pure types + the
 * `isCompositeGate` type guard live here so `types/algorithm.ts` can
 * reference `MarketStateGateConfig` without leaking the lib dependency
 * back into the type layer.
 */

import type { DxyState, MtfState, RangeState, VolState } from "@/types/market-state";

export type EntryZone = "premium" | "discount" | "equilibrium" | "n/a";
export type EntryHourBucket =
  | "asia(0-7)"
  | "london(7-13)"
  | "ny(13-21)"
  | "late(21-24)";

export interface MarketStateGate {
  /** allow:       entry permitted ONLY while every configured feature's
   *               current value is in its list (AND across features).
   *  block:       entry refused while ANY configured feature's current
   *               value is in its list (OR across features). Use for
   *               single-feature blacklists ("block when vol=high").
   *  block_joint: entry refused while EVERY configured feature's
   *               current value is in its list (AND across features).
   *               Use for V1-cluster blocks — the cluster is a joint
   *               condition, not a single-feature one. */
  mode: "allow" | "block" | "block_joint";
  /** Features the gate cares about. Omitted features are unconstrained.
   *  Within a feature the list is OR; across features it is AND. */
  states: {
    mtf?: Exclude<MtfState, "n/a">[];
    vol?: Exclude<VolState, "n/a">[];
    range?: Exclude<RangeState, "n/a">[];
    dxy?: Exclude<DxyState, "n/a">[];
    entry_zone?: Exclude<EntryZone, "n/a">[];
    entry_hour_bucket?: EntryHourBucket[];
  };
  /** Policy when the state (or a configured feature) is unreadable
   *  ("n/a" / null). Default "block": a regime specialist that cannot
   *  read its regime must not fire blind. */
  on_unreadable?: "block" | "allow";
  /** Shadow mode. When true, the gate computes its verdict normally
   *  but always returns allowed=true; the would-be refusal reason is
   *  surfaced on the verdict as `shadow_block_reason`. Use to verify a
   *  historical cluster signature on live data before flipping to
   *  enforce. */
  shadow?: boolean;
}

export interface GateVerdict {
  allowed: boolean;
  reason: string;
  /** Set ONLY when shadow=true and the gate would have refused. */
  shadow_block_reason?: string;
}

/** Composite gate: AND-combination of clauses. Entry refused unless EVERY
 *  clause allows. Use when stacking independently-derived rules — e.g.
 *  an existing allow-mode mtf clause + a V1.2 cluster block_joint clause.
 *
 *  Shadow semantics:
 *    - composite-level `shadow: true` shadows the ENTIRE stack: per-clause
 *      shadows are ignored and the composite returns allowed=true on any
 *      refusal, with the would-block reason surfaced. Use when trialling
 *      the whole stack as a unit.
 *    - composite-level shadow undefined/false PRESERVES per-clause
 *      shadow flags — a clause with shadow=true that would refuse returns
 *      allowed=true (its shadow_block_reason bubbles up), and the
 *      composite continues. A clause with shadow not set that refuses
 *      hard-refuses the composite. This is what enables "shadow the newly
 *      deployed cluster clause + keep enforcing the existing clause." */
export interface MarketStateGateComposite {
  clauses: MarketStateGate[];
  shadow?: boolean;
}

export type MarketStateGateConfig = MarketStateGate | MarketStateGateComposite;

export function isCompositeGate(
  config: MarketStateGateConfig
): config is MarketStateGateComposite {
  return Array.isArray((config as MarketStateGateComposite).clauses);
}

/** Context required to evaluate the entry-zone and entry-hour-bucket
 *  features. Omit when configuring only state-derived features
 *  (mtf/vol/range/dxy). */
export interface GateContext {
  /** UTC hour of the candidate entry bar (0-23). */
  entryHourUtc?: number;
  /** 0-100. Where the candidate entry price sits in the most recent
   *  20-bar high-low range. Pass null when bars are thin. */
  positionInRangePct?: number | null;
}
