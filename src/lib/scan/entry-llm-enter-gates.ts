/**
 * Post-LLM-decision enter-branch gates — fire AFTER the LLM has
 * returned `enter_long`/`enter_short` but BEFORE the `openPosition` call.
 * Extracted from `entry-llm-trader.ts` in CB.H1 pass 5 (2026-06-22).
 *
 * 5 gates in order (all behave like the defensive pre-gates — return
 * `{ blocked: true }` after a `signal_no_action` log if they fire,
 * `{ blocked: false }` to fall through):
 *
 *  1. **RANGING regime block** — applies only to prompts WITHOUT multi-TF
 *     override capability (v1-v4). v5+/v2_mtf have explicit multi-TF
 *     override logic; hard-blocking them defeats the design. Capability
 *     comes from `PROMPT_HAS_MTF_OVERRIDE`, not a hardcoded list.
 *  2. **Capped (cappedReason)** — orchestrator's position-cap signal:
 *     algo's max_positions / max_per_ticker is full. Log near-miss
 *     so the considered feed shows the entry was viable; don't open.
 *  3. **Dry-run** — `llm_trader.dry_run` flag set; log would-have-entered
 *     but skip the order.
 *  4. **Live spread gate** — broker-only; refuses when current bid/ask
 *     gap exceeds catalog typical × multiplier (2.5x). Paper-only mode
 *     skips by definition (no brokerCtx).
 *  5. **Live-price drift gate** — refuses when broker live quote has
 *     moved >0.20% in either direction from the bar-close the LLM
 *     analyzed. See live-price-drift-gate.ts for the 2026-05-12 incident
 *     (top-tick on adverse drift) + absolute-drift revision (falling-knife
 *     re-entry).
 *
 * Removed-but-documented: cohort gates (#136 LH-short upper-range, #137
 * HH-long lower-range) were calibrated against beyr1223h Apr 2026 data
 * — a single chop-window sample. Risk analysis showed they would block
 * winners in trending markets (HH-long lower-range gate refuses entries
 * >0.30% above 20-bar low; in a sustained uptrend, price is ALWAYS
 * >0.30% above old lows). Removed 2026-05-06. Cohort judgment is
 * returned to the LLM, which already has regime + range + momentum.
 * Phase 2 path: activate Layer 3 cohort breakdown via
 * `summariseRecentOutcomes` — surface "your last 10 HH-long entries far
 * from low went X/Y" so the LLM weighs the signal as data, not as a
 * hard block.
 */
import { checkLivePriceDrift } from "@/lib/algorithm/live-price-drift-gate";
import { checkBrokerSpread } from "@/lib/algorithm/spread-gate";
import { logActivity } from "./helpers";
import { PROMPT_HAS_MTF_OVERRIDE } from "./llm-trader-prompts";
import type { EntryContext } from "./entry";
import type { LlmTraderDecision, LlmTraderEvaluation } from "./llm-trader";

export interface EnterGatesResult {
  blocked: boolean;
}

export async function checkLlmEnterGates(
  ctx: EntryContext,
  llmSide: "long" | "short",
  decision: LlmTraderDecision,
  evaluation: LlmTraderEvaluation
): Promise<EnterGatesResult> {
  const { supabase, userId, algo, ticker, closes, livePrice, brokerCtx, cappedReason } = ctx;
  const llmConfig = algo.rules.llm_trader;

  // RANGING block — see file-header docstring for the prompt-version
  // rationale (v1-v4 hard-block, v5+/v2_mtf trust the multi-TF override).
  // Schema note: prompt_version defaults to v2 when unset
  // (DEFAULT_PROMPT_VERSION in llm-trader-prompts.ts). Undefined treated
  // as legacy → block applies.
  const hasMultiTfOverride = llmConfig?.prompt_version
    ? PROMPT_HAS_MTF_OVERRIDE[llmConfig.prompt_version]
    : false;
  if (evaluation.regime === "RANGING" && !hasMultiTfOverride) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: `RANGING regime block: 0/4 historical WR (-$2,217 in beyr1223h 30d). Chop regime has structurally negative EV for ${llmConfig?.prompt_version ?? "legacy"} prompt — hold and wait for regime shift.`,
        source: "llm_trader",
        regime: evaluation.regime,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        would_have_entered_side: llmSide,
      },
    });
    return { blocked: true };
  }

  // Capped: log near-miss with LLM reasoning, don't open.
  if (cappedReason) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: cappedReason,
        source: "llm_trader",
        regime: evaluation.regime,
        would_have_entered_side: llmSide,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
        would_have_entered: true,
      },
    });
    return { blocked: true };
  }

  // Dry-run: log but don't open.
  if (llmConfig?.dry_run) {
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: "dry_run mode — would have entered",
        source: "llm_trader",
        regime: evaluation.regime,
        would_have_entered_side: llmSide,
        confidence: decision.confidence,
        llm_reasoning: decision.reasoning,
      },
    });
    return { blocked: true };
  }

  const spreadBlocked = await runSpreadGate({ supabase, userId, algoId: algo.id, ticker, brokerCtx, regime: evaluation.regime });
  if (spreadBlocked) return { blocked: true };

  const driftBlocked = await runLivePriceDriftGate({
    supabase,
    userId,
    algoId: algo.id,
    ticker,
    llmSide,
    closes,
    livePrice,
    decision,
    evaluation,
  });
  if (driftBlocked) return { blocked: true };

  return { blocked: false };
}

interface SpreadGateArgs {
  supabase: EntryContext["supabase"];
  userId: string;
  algoId: string;
  ticker: string;
  brokerCtx: EntryContext["brokerCtx"];
  regime: LlmTraderEvaluation["regime"];
}

async function runSpreadGate(a: SpreadGateArgs): Promise<boolean> {
  if (!a.brokerCtx) return false;
  const spread = await checkBrokerSpread(a.brokerCtx.adapter, a.brokerCtx.conn, a.ticker);
  if (!spread.block) return false;
  await logActivity(a.supabase, a.userId, {
    algorithm_id: a.algoId,
    event_type: "signal_no_action",
    ticker: a.ticker,
    details: {
      reason: spread.reason ?? "Live spread gate triggered",
      source: "llm_trader",
      regime: a.regime,
      observed_spread_pips: spread.observed_spread_pips,
      threshold_pips: spread.threshold_pips,
    },
  });
  return true;
}

interface DriftGateArgs {
  supabase: EntryContext["supabase"];
  userId: string;
  algoId: string;
  ticker: string;
  llmSide: "long" | "short";
  closes: number[];
  livePrice: EntryContext["livePrice"];
  decision: LlmTraderDecision;
  evaluation: LlmTraderEvaluation;
}

async function runLivePriceDriftGate(a: DriftGateArgs): Promise<boolean> {
  const drift = checkLivePriceDrift({
    side: a.llmSide,
    barClose: a.closes[a.closes.length - 1],
    livePrice: a.livePrice,
  });
  if (!drift.block) return false;
  await logActivity(a.supabase, a.userId, {
    algorithm_id: a.algoId,
    event_type: "signal_no_action",
    ticker: a.ticker,
    details: {
      reason: drift.reason ?? "Live-price drift gate triggered",
      source: "llm_trader",
      regime: a.evaluation.regime,
      would_have_entered_side: a.llmSide,
      confidence: a.decision.confidence,
      llm_reasoning: a.decision.reasoning,
      bar_close: drift.bar_close,
      live_price: drift.live_price,
      drift_pct: drift.drift_pct,
      drift_abs_pct: drift.drift_abs_pct,
      threshold_pct: drift.threshold_pct,
    },
  });
  return true;
}
