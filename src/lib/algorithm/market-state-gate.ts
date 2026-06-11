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
 */
import type {
  DxyState,
  MarketState,
  MtfState,
  RangeState,
  VolState,
} from "@/lib/market-data/market-state";

export interface MarketStateGate {
  /** allow: entry permitted ONLY while every configured feature's current
   *  value is in its list. block: entry refused while ANY configured
   *  feature's current value is in its list. */
  mode: "allow" | "block";
  /** Features the gate cares about. Omitted features are unconstrained.
   *  Within a feature the list is OR; across features it is AND. */
  states: {
    mtf?: Exclude<MtfState, "n/a">[];
    vol?: Exclude<VolState, "n/a">[];
    range?: Exclude<RangeState, "n/a">[];
    dxy?: Exclude<DxyState, "n/a">[];
  };
  /** Policy when the state (or a configured feature) is unreadable
   *  ("n/a" / null). Default "block": a regime specialist that cannot
   *  read its regime must not fire blind. */
  on_unreadable?: "block" | "allow";
}

export interface GateVerdict {
  allowed: boolean;
  reason: string;
}

const FEATURE_KEYS = ["mtf", "vol", "range", "dxy"] as const;

export function checkMarketStateGate(
  gate: MarketStateGate,
  state: MarketState | null
): GateVerdict {
  const onUnreadable = gate.on_unreadable ?? "block";
  const configured = FEATURE_KEYS.filter((k) => (gate.states[k]?.length ?? 0) > 0);
  if (configured.length === 0) {
    return { allowed: true, reason: "gate configures no states" };
  }

  const unreadableVerdict = (what: string): GateVerdict =>
    onUnreadable === "allow"
      ? { allowed: true, reason: `${what} unreadable — on_unreadable=allow` }
      : { allowed: false, reason: `${what} unreadable — fail closed` };

  if (!state) return unreadableVerdict("market state");

  for (const key of configured) {
    const current = state[key];
    if (current === "n/a") return unreadableVerdict(`${key} state`);
    const list = gate.states[key] as string[];
    const inList = list.includes(current);
    if (gate.mode === "allow" && !inList) {
      return {
        allowed: false,
        reason: `${key}=${current} not in allowed [${list.join(", ")}]`,
      };
    }
    if (gate.mode === "block" && inList) {
      return {
        allowed: false,
        reason: `${key}=${current} is blocked`,
      };
    }
  }

  return {
    allowed: true,
    reason:
      gate.mode === "allow"
        ? `state matches allowed regime (${configured.map((k) => `${k}=${state[k]}`).join(", ")})`
        : "no blocked state matched",
  };
}
