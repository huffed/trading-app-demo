/**
 * Market-state gate — the regime-library dormancy mechanism.
 *
 * Each library algorithm declares the market states it is allowed (or
 * forbidden) to enter in via `rules.market_state_gate`. The engine
 * evaluates the gate every tick against the live-computed MarketState
 * (src/lib/market-data/market-state.ts), so strategies wake and sleep
 * with the regime — no human toggling, ever. Dormancy = gate doesn't
 * match; the algorithm itself stays status='active' permanently.
 *
 * Scoping rules (feedback_gate_doing_too_much): the gate is configured
 * per-algorithm in rules — never a global list — and the engine only
 * consults it when FLAT. In-position management is never muzzled.
 *
 * For LLM algorithms the engine runs this BEFORE the Anthropic call, so
 * a dormant specialist spends $0.
 *
 * Features:
 *   - mtf / vol / range / dxy — from live MarketState
 *   - entry_zone — premium / discount / equilibrium, derived from
 *     position-in-range using V1 cluster-mining thresholds (≥67% / <33%)
 *   - entry_hour_bucket — asia / london / ny / late, derived from
 *     entry hour UTC, matching V1 cluster-mining buckets
 *
 * The entry_zone thresholds INTENTIONALLY differ from
 * `src/lib/scan/entry.ts` cohort attribution (which uses ≥60% / ≤40%).
 * The gate must use V1 thresholds because any deployed block-mode rule
 * is calibrated against V1-bucketed cluster mining; the cohort
 * attribution table preserves the older thresholds so historical rows
 * stay interpretable. Don't reconcile them — they serve different
 * purposes.
 */
// CB.M4 (2026-06-19 EVE): types in `src/types/market-state-gate.ts`.
// CB.H1 pass 10 (2026-06-22): cohort feature derivers in `./market-state-features`.
import type { MarketState } from "@/types/market-state";
import {
  isCompositeGate,
  type GateContext,
  type GateVerdict,
  type MarketStateGate,
  type MarketStateGateConfig,
} from "@/types/market-state-gate";
import {
  STATE_FEATURE_KEYS,
  computeEntryHourBucket,
  computeEntryZone,
} from "./market-state-features";
export {
  isCompositeGate,
  type EntryHourBucket,
  type EntryZone,
  type GateContext,
  type GateVerdict,
  type MarketStateGate,
  type MarketStateGateComposite,
  type MarketStateGateConfig,
} from "@/types/market-state-gate";
export {
  STATE_FEATURE_KEYS,
  computeEntryHourBucket,
  computePositionInRangePct,
  computeEntryZone,
} from "./market-state-features";

/** Stable display string for the `gate_mode` telemetry field. Single
 *  clauses report their own mode; composites report `composite_and`. */
export function gateConfigModeLabel(config: MarketStateGateConfig): string {
  return isCompositeGate(config) ? "composite_and" : config.mode;
}

interface FeatureCheck {
  matched: boolean;
  refuseReason: string;
  acceptDesc: string;
}

export function checkMarketStateGate(
  gate: MarketStateGate,
  state: MarketState | null,
  ctx: GateContext = {}
): GateVerdict {
  const stateConfigured = STATE_FEATURE_KEYS.filter((k) => (gate.states[k]?.length ?? 0) > 0);
  const entryZoneList = gate.states.entry_zone ?? [];
  const entryHourList = gate.states.entry_hour_bucket ?? [];
  if (stateConfigured.length + entryZoneList.length + entryHourList.length === 0) {
    return { allowed: true, reason: "gate configures no states" };
  }
  const { checks, unreadable } = collectFeatureChecks(gate, state, ctx, stateConfigured, entryZoneList, entryHourList);
  const verdict = resolveGateVerdict(gate, checks, unreadable);
  if (gate.shadow && !verdict.allowed) {
    return {
      allowed: true,
      reason: `shadow: would-block (${verdict.reason})`,
      shadow_block_reason: verdict.reason,
    };
  }
  return verdict;
}

/** Walk every configured feature and collect (matched/refuseReason)
 *  per-feature check rows. Short-circuits to `unreadable` when any
 *  feature's current value is "n/a" or absent from ctx. */
function collectFeatureChecks(
  gate: MarketStateGate,
  state: MarketState | null,
  ctx: GateContext,
  stateConfigured: readonly (typeof STATE_FEATURE_KEYS)[number][],
  entryZoneList: string[],
  entryHourList: string[]
): { checks: FeatureCheck[]; unreadable: string | null } {
  const checks: FeatureCheck[] = [];
  let unreadable: string | null = null;
  const record = (key: string, current: string, list: string[]) =>
    checks.push(buildFeatureCheck(gate.mode, key, current, list));
  if (stateConfigured.length > 0) {
    if (!state) unreadable = "market state";
    else {
      for (const key of stateConfigured) {
        const current = state[key];
        if (current === "n/a") {
          unreadable = `${key} state`;
          break;
        }
        record(key, current, gate.states[key] as string[]);
      }
    }
  }
  if (entryZoneList.length > 0 && unreadable == null) {
    const zone = computeEntryZone(ctx.positionInRangePct);
    if (zone === "n/a") unreadable = "entry_zone";
    else record("entry_zone", zone, entryZoneList);
  }
  if (entryHourList.length > 0 && unreadable == null) {
    if (ctx.entryHourUtc == null) unreadable = "entry_hour_bucket";
    else record("entry_hour_bucket", computeEntryHourBucket(ctx.entryHourUtc), entryHourList);
  }
  return { checks, unreadable };
}

function buildFeatureCheck(
  mode: MarketStateGate["mode"],
  key: string,
  current: string,
  list: string[]
): FeatureCheck {
  const matched = list.includes(current);
  if (mode === "allow") {
    return {
      matched,
      refuseReason: matched ? "" : `${key}=${current} not in allowed [${list.join(", ")}]`,
      acceptDesc: `${key}=${current}`,
    };
  }
  return {
    matched,
    refuseReason: matched ? `${key}=${current} is blocked` : "",
    acceptDesc: `${key}=${current}`,
  };
}

/** Combine the per-feature checks + unreadable state into the final
 *  verdict, applying the gate's mode (allow / block / block_joint) +
 *  on_unreadable policy. */
function resolveGateVerdict(
  gate: MarketStateGate,
  checks: FeatureCheck[],
  unreadable: string | null
): GateVerdict {
  const onUnreadable = gate.on_unreadable ?? "block";
  if (unreadable != null) {
    return onUnreadable === "allow"
      ? { allowed: true, reason: `${unreadable} unreadable — on_unreadable=allow` }
      : { allowed: false, reason: `${unreadable} unreadable — fail closed` };
  }
  if (gate.mode === "allow") {
    const refuseReasons = checks.filter((c) => c.refuseReason).map((c) => c.refuseReason);
    return refuseReasons.length > 0
      ? { allowed: false, reason: refuseReasons.join("; ") }
      : { allowed: true, reason: `state matches allowed regime (${checks.map((c) => c.acceptDesc).join(", ")})` };
  }
  if (gate.mode === "block") {
    const refuseReasons = checks.filter((c) => c.matched).map((c) => c.refuseReason);
    return refuseReasons.length > 0
      ? { allowed: false, reason: refuseReasons.join("; ") }
      : { allowed: true, reason: "no blocked state matched" };
  }
  // block_joint — every configured feature must match for refusal.
  const allMatched = checks.length > 0 && checks.every((c) => c.matched);
  const refuseReasons = checks.filter((c) => c.matched).map((c) => c.refuseReason);
  return allMatched
    ? { allowed: false, reason: `joint block (${refuseReasons.join(" AND ")})` }
    : { allowed: true, reason: "joint block not satisfied" };
}

/** Dispatcher — accepts either a single MarketStateGate or a composite.
 *
 *  Composite semantics: AND across clauses. Two modes determined by
 *  `config.shadow`:
 *
 *  1. `config.shadow === true` — the entire composite shadows. Per-clause
 *     shadow flags are stripped; the composite refuses on the first
 *     non-allowed clause, then converts the refusal to allowed=true with
 *     `shadow_block_reason` set. Use when trialling the whole stack.
 *
 *  2. otherwise — per-clause shadow is RESPECTED. A clause with
 *     `shadow: true` that would refuse returns allowed=true with its own
 *     `shadow_block_reason`; the composite records it and continues. A
 *     clause without shadow that refuses hard-refuses the composite.
 *     The composite's final verdict propagates the FIRST clause's
 *     `shadow_block_reason` it saw (so the operator can see what would
 *     have been blocked, while keeping the enforced clauses live). */
export function checkMarketStateGateConfig(
  config: MarketStateGateConfig,
  state: MarketState | null,
  ctx: GateContext = {}
): GateVerdict {
  if (!isCompositeGate(config)) return checkMarketStateGate(config, state, ctx);

  if (config.clauses.length === 0) {
    return { allowed: true, reason: "composite has no clauses" };
  }

  const compositeShadow = config.shadow === true;
  const verdicts: { clause: number; verdict: GateVerdict }[] = [];
  let firstShadowReason: { clause: number; reason: string } | null = null;
  let refusedAt: { clause: number; verdict: GateVerdict } | null = null;

  for (let i = 0; i < config.clauses.length; i++) {
    // When a non-shadow clause has already refused, only continue
    // evaluating SHADOW clauses (for telemetry) — non-shadow clauses
    // after refusal can't change the AND-composite verdict so we skip
    // them for efficiency. This is the "shadow telemetry survives a
    // hard refusal" fix (2026-06-16): without it, V1.2 shadow clauses
    // placed after a hard `block` clause never fire because the loop
    // short-circuits, leaving us with zero shadow data to validate
    // whether the V1.2 gate would ALSO catch entries the hard gate
    // already catches (redundant) or DIFFERENT entries (complementary).
    if (refusedAt && config.clauses[i].shadow !== true) continue;

    // In whole-composite shadow mode, strip per-clause shadow so we can
    // see the underlying clause verdict and re-shadow at the composite
    // level on refusal. Otherwise leave the clause untouched so its
    // own shadow flag governs.
    const clauseForEval: MarketStateGate = compositeShadow
      ? { ...config.clauses[i], shadow: false }
      : config.clauses[i];
    const v = checkMarketStateGate(clauseForEval, state, ctx);
    verdicts.push({ clause: i, verdict: v });

    if (!compositeShadow && v.shadow_block_reason && !firstShadowReason) {
      firstShadowReason = { clause: i, reason: v.shadow_block_reason };
    }
    if (!v.allowed && !refusedAt) {
      refusedAt = { clause: i, verdict: v };
      // Don't break — keep iterating to evaluate any remaining shadow
      // clauses for telemetry. Subsequent non-shadow clauses are skipped
      // at the top of the loop.
    }
  }

  if (!refusedAt) {
    const acceptReasons = verdicts.map((v) => `[#${v.clause}] ${v.verdict.reason}`).join("; ");
    const verdict: GateVerdict = {
      allowed: true,
      reason: `composite passed (${acceptReasons})`,
    };
    if (firstShadowReason) {
      verdict.shadow_block_reason = `clause #${firstShadowReason.clause}: ${firstShadowReason.reason}`;
    }
    return verdict;
  }

  const composedReason = `composite_and clause #${refusedAt.clause} refused: ${refusedAt.verdict.reason}`;

  if (compositeShadow) {
    return {
      allowed: true,
      reason: `shadow: would-block (${composedReason})`,
      shadow_block_reason: composedReason,
    };
  }
  // Hard refusal — but surface any shadow clause that would ALSO block,
  // so the operator can see whether the V1.2 shadow gate (or any other
  // shadow clause) is redundant with the hard gate (caught the same
  // entry) or complementary (would have caught a different population).
  const verdict: GateVerdict = { allowed: false, reason: composedReason };
  if (firstShadowReason) {
    verdict.shadow_block_reason = `clause #${firstShadowReason.clause}: ${firstShadowReason.reason}`;
  }
  return verdict;
}
