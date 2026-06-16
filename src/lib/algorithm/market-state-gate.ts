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
import type {
  DxyState,
  MarketState,
  MtfState,
  RangeState,
  VolState,
} from "@/lib/market-data/market-state";

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

/** Stable display string for the `gate_mode` telemetry field. Single
 *  clauses report their own mode; composites report `composite_and`. */
export function gateConfigModeLabel(config: MarketStateGateConfig): string {
  return isCompositeGate(config) ? "composite_and" : config.mode;
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

const STATE_FEATURE_KEYS = ["mtf", "vol", "range", "dxy"] as const;

/** V1 cluster-mining thresholds (see header). */
export function computeEntryZone(positionInRangePct: number | null | undefined): EntryZone {
  if (positionInRangePct == null) return "n/a";
  if (positionInRangePct < 33) return "discount";
  if (positionInRangePct < 67) return "equilibrium";
  return "premium";
}

export function computeEntryHourBucket(entryHourUtc: number): EntryHourBucket {
  if (entryHourUtc < 7) return "asia(0-7)";
  if (entryHourUtc < 13) return "london(7-13)";
  if (entryHourUtc < 21) return "ny(13-21)";
  return "late(21-24)";
}

/** Compute position-in-range pct as a 20-bar high-low locator. Returns
 *  null when bars are thin (<20) or the window has zero width. Used by
 *  both live and backtest paths to build GateContext for the gate's
 *  entry_zone feature. */
export function computePositionInRangePct(
  bars: { high: number; low: number }[],
  currentPrice: number
): number | null {
  if (bars.length < 20) return null;
  const window = bars.slice(-20);
  let high = -Infinity;
  let low = Infinity;
  for (const b of window) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  if (high <= low) return null;
  const pct = ((currentPrice - low) / (high - low)) * 100;
  return Math.max(0, Math.min(100, pct));
}

export function checkMarketStateGate(
  gate: MarketStateGate,
  state: MarketState | null,
  ctx: GateContext = {}
): GateVerdict {
  const onUnreadable = gate.on_unreadable ?? "block";
  const stateConfigured = STATE_FEATURE_KEYS.filter(
    (k) => (gate.states[k]?.length ?? 0) > 0
  );
  const entryZoneList = gate.states.entry_zone ?? [];
  const entryHourList = gate.states.entry_hour_bucket ?? [];
  const totalConfigured =
    stateConfigured.length + entryZoneList.length + entryHourList.length;
  if (totalConfigured === 0) {
    return { allowed: true, reason: "gate configures no states" };
  }

  /** Per-feature evaluation. For allow: "match" = value-in-list; refuse
   *  on mismatch. For block: "match" = value-in-list; refuse on match.
   *  For block_joint: track matches; refuse only if EVERY feature matched.
   *  Unreadable: short-circuits with on_unreadable policy. */
  interface FeatureCheck {
    matched: boolean;
    refuseReason: string;
    acceptDesc: string;
  }
  const checks: FeatureCheck[] = [];
  let unreadable: string | null = null;

  const recordCheck = (key: string, current: string, list: string[]) => {
    const matched = list.includes(current);
    if (gate.mode === "allow") {
      checks.push({
        matched,
        refuseReason: matched
          ? ""
          : `${key}=${current} not in allowed [${list.join(", ")}]`,
        acceptDesc: `${key}=${current}`,
      });
    } else {
      // block or block_joint — "matched" means the value is in the
      // blocked list; reason wording is the same.
      checks.push({
        matched,
        refuseReason: matched ? `${key}=${current} is blocked` : "",
        acceptDesc: `${key}=${current}`,
      });
    }
  };

  if (stateConfigured.length > 0) {
    if (!state) {
      unreadable = "market state";
    } else {
      for (const key of stateConfigured) {
        const current = state[key];
        if (current === "n/a") {
          unreadable = `${key} state`;
          break;
        }
        recordCheck(key, current, gate.states[key] as string[]);
      }
    }
  }

  if (entryZoneList.length > 0 && unreadable == null) {
    const zone = computeEntryZone(ctx.positionInRangePct);
    if (zone === "n/a") {
      unreadable = "entry_zone";
    } else {
      recordCheck("entry_zone", zone, entryZoneList as string[]);
    }
  }

  if (entryHourList.length > 0 && unreadable == null) {
    if (ctx.entryHourUtc == null) {
      unreadable = "entry_hour_bucket";
    } else {
      const bucket = computeEntryHourBucket(ctx.entryHourUtc);
      recordCheck("entry_hour_bucket", bucket, entryHourList as string[]);
    }
  }

  let verdict: GateVerdict;
  if (unreadable != null) {
    verdict =
      onUnreadable === "allow"
        ? { allowed: true, reason: `${unreadable} unreadable — on_unreadable=allow` }
        : { allowed: false, reason: `${unreadable} unreadable — fail closed` };
  } else if (gate.mode === "allow") {
    const refuseReasons = checks.filter((c) => c.refuseReason).map((c) => c.refuseReason);
    verdict =
      refuseReasons.length > 0
        ? { allowed: false, reason: refuseReasons.join("; ") }
        : {
            allowed: true,
            reason: `state matches allowed regime (${checks.map((c) => c.acceptDesc).join(", ")})`,
          };
  } else if (gate.mode === "block") {
    // any match refuses
    const refuseReasons = checks.filter((c) => c.matched).map((c) => c.refuseReason);
    verdict =
      refuseReasons.length > 0
        ? { allowed: false, reason: refuseReasons.join("; ") }
        : { allowed: true, reason: "no blocked state matched" };
  } else {
    // block_joint — every configured feature must match for refusal.
    // (Empty config already handled at top.)
    const allMatched = checks.length > 0 && checks.every((c) => c.matched);
    const refuseReasons = checks.filter((c) => c.matched).map((c) => c.refuseReason);
    verdict = allMatched
      ? {
          allowed: false,
          reason: `joint block (${refuseReasons.join(" AND ")})`,
        }
      : { allowed: true, reason: "joint block not satisfied" };
  }

  if (gate.shadow && !verdict.allowed) {
    return {
      allowed: true,
      reason: `shadow: would-block (${verdict.reason})`,
      shadow_block_reason: verdict.reason,
    };
  }
  return verdict;
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
    if (!v.allowed) {
      refusedAt = { clause: i, verdict: v };
      break;
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
  return { allowed: false, reason: composedReason };
}
