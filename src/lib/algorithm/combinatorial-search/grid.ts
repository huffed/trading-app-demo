/**
 * Curated grid of candidate algorithm rules. Eight strategy templates
 * (5 indicator-based, 3 ICT/SMC pattern-based) crossed with a small
 * set of timeframe / SL-TP / risk variations gives ~50 candidates
 * before pre-budget trimming — enough variety to explore the space
 * meaningfully without exploding the wall-clock budget.
 *
 * Each template is a partial AlgorithmRules with the entry shape and
 * default side; the grid layer fills in the rest (timeframe, SL/TP,
 * sizing, filters, exits) so we don't repeat boilerplate per template.
 *
 * Templates are deliberately conservative on filter mix — every
 * candidate ships with regime_filter + adx_filter + intraday ATR gate
 * (always-on) + stagnant_exit + consistency_rule. The recent shipped
 * gates are wins on every algorithm we've tested; bake them in.
 *
 * Future expansion: when the grid grows past ~80 candidates per run,
 * switch from cartesian enumeration to stratified sampling so the
 * cardinality stays bounded regardless of new templates.
 */
import type { AlgorithmRules, EntryCondition, EntryLogic } from "@/types/algorithm";
// CB.H1 pass 18 (2026-06-22): TEMPLATES + PARAMETER_GRID + 5 helper
// builders + ParamVariant/Template/ParameterCombo interfaces moved to
// `./grid-templates.ts`. This file keeps the orchestrator + assembleRules
// + enumerateCandidates only.
import { EXIT_VARIANTS } from "./exit-variants";
import { PARAMETER_GRID, TEMPLATES, type ParameterCombo } from "./grid-templates";



export interface Candidate {
  /** Stable label for logging and diagnostics. */
  label: string;
  /** Full rule set ready to feed to runWalkForward. */
  rules: AlgorithmRules;
  template_name: string;
}

/**
 * 3D cartesian product of templates × parameter combos × exit variants.
 * Post-filtered by each template's `allowed_timeframes`. With the
 * default templates × params × 3 exit variants, ~150-250 candidates;
 * the search runner caps to its `max_candidates` budget (default 300
 * to fit the full set).
 *
 * The 3rd dimension exists because today's "exit conditions help or
 * hurt is template-specific" empirical finding — bearish-BOS exits
 * doubled ict_bos_orderblock EV (+0.33R → +0.66R) but destroyed
 * momentum_solo (+0.25R → -0.33R). Enumerating exit variants per
 * candidate lets walk-forward pick the empirically best combination.
 */
export function enumerateCandidates(input: {
  capital: number;
  monthly_target_pct: number;
}): Candidate[] {
  const out: Candidate[] = [];
  for (const tmpl of TEMPLATES) {
    for (const combo of PARAMETER_GRID) {
      if (tmpl.allowed_timeframes && !tmpl.allowed_timeframes.includes(combo.timeframe)) {
        continue;
      }
      // Iterate over all template variants: default + any parameter
      // sweeps defined on the template. Default builds with no suffix;
      // sweep variants get their `name` suffix appended.
      const variantBuilds: Array<{ suffix: string; build: typeof tmpl.build }> = [
        { suffix: "", build: tmpl.build },
        ...(tmpl.param_variants ?? []).map((v) => ({
          suffix: `__${v.name}`,
          build: v.build,
        })),
      ];

      for (const variantBuild of variantBuilds) {
        const built = variantBuild.build(combo.timeframe);
        if (!built) continue;
        const variantTag = variantBuild.suffix;
        const isGold = tmpl.name.startsWith("gold_");

          for (const exitVariant of EXIT_VARIANTS) {
          const exit = exitVariant.build(tmpl.name, combo.timeframe, tmpl.default_side);
          if (exit === null) continue;

          const exitSuffix = exitVariant.name === "no_exit" ? "" : `__${exitVariant.name}`;

          out.push({
            label: `${tmpl.name}${variantTag}__${combo.label}${exitSuffix}`,
            template_name: tmpl.name,
            rules: assembleRules(built, combo, tmpl.default_side, input.capital, {
              is_gold: isGold,
              exit_conditions: exit.exit_conditions,
              exit_logic: exit.exit_logic,
            }),
          });
          if (tmpl.include_tf_conviction_variant) {
            // Same conditions/SL/TP/exits, swapped sizing.
            out.push({
              label: `${tmpl.name}${variantTag}__${combo.label}__conv${exitSuffix}`,
              template_name: tmpl.name,
              rules: assembleRules(built, combo, tmpl.default_side, input.capital, {
                sizing: "conviction_tf_agreement",
                is_gold: isGold,
                exit_conditions: exit.exit_conditions,
                exit_logic: exit.exit_logic,
              }),
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Assemble a full AlgorithmRules from the template fragment + parameter
 * combo. Sizing defaults to 0.5% risk_per_trade — a conservative starting
 * point that the scorer can later calibrate against the user's monthly
 * target. All the recent-shipped gates (regime, ADX, intraday ATR,
 * stagnant, consistency) are baked in so candidates are tested against
 * the same gating that runs live.
 */
interface AssembleOptions {
  /** Sizing variant. Default `"risk_per_trade"` (flat). The
   *  `"conviction_tf_agreement"` variant scales risk with cross-TF
   *  agreement count; pairs with `convictionMultiplierByTfAgreement`. */
  sizing?: "risk_per_trade" | "conviction_tf_agreement";
  /** True for gold-specific templates. Sets asset_class to "commodity",
   *  bumps leverage to FTMO's actual 1:50 cap on XAU pairs, and tightens
   *  stagnant_exit on 15m candidates to match gold's faster price action. */
  is_gold?: boolean;
  /** Exit conditions to bake into the rule. Defaults to none ([] +
   *  undefined logic) — preserves the legacy 2D-search behaviour for
   *  any caller that doesn't supply exits. The 3D-enumeration loop
   *  always sets these explicitly. */
  exit_conditions?: EntryCondition[];
  exit_logic?: AlgorithmRules["exit_logic"];
}

function assembleRules(
  built: { entry: EntryCondition[]; logic: EntryLogic },
  combo: ParameterCombo,
  side: "long" | "short" | "auto",
  capital: number,
  options: AssembleOptions = {}
): AlgorithmRules {
  const isGold = options.is_gold ?? false;
  const positionSizing: AlgorithmRules["position_sizing"] =
    options.sizing === "conviction_tf_agreement"
      ? {
          // Base risk = 0.25%. With max_multiplier = 4, peak risk on a
          // full-TF-agreement trade is 1.0% — well inside the FTMO-safe
          // 2% cap, leaving headroom for the calibrator to scale up to
          // the user's monthly target.
          type: "conviction_scaled",
          value: 0.25,
          max_multiplier: 4,
          conviction_metric: "tf_agreement",
        }
      : { type: "risk_per_trade", value: 0.5 };
  // Tighter stagnant_exit on 15m candidates — gold's 15m setups should
  // resolve fast (4h max hold) and we cut deeper into red sooner so spread
  // drag doesn't compound on stalled scalps. Other timeframes use the
  // legacy 48-bar / -0.5R defaults that the active forex algo runs.
  const stagnantExit =
    combo.timeframe === "15m"
      ? {
          enabled: true,
          max_bars: 16,
          min_excursion_r: 0.1,
          min_pnl_r: -0.3,
        }
      : {
          enabled: true,
          max_bars: 48,
          min_excursion_r: 0.1,
          min_pnl_r: -0.5,
        };
  const rules: AlgorithmRules = {
    entry_conditions: built.entry,
    entry_logic: built.logic,
    exit_conditions: options.exit_conditions ?? [],
    ...(options.exit_logic !== undefined ? { exit_logic: options.exit_logic } : {}),
    stop_loss: { type: "percentage", value: combo.sl_pct },
    take_profit: { type: "percentage", value: combo.tp_pct },
    position_sizing: positionSizing,
    max_positions: 5,
    max_per_ticker: 1,
    // FTMO improved gold leverage to 1:50 on 2026-02-01 (XAUUSD/EUR/AUD).
    // Forex stays at the conservative 1:30 — well inside FTMO's actual
    // 1:100 cap but matches the active forex algo's deployed setting.
    leverage: isGold ? 50 : 30,
    timeframe: combo.timeframe,
    asset_class: isGold ? "commodity" : "forex",
    side,
    prop_firm: {
      daily_loss_limit: 5,
      max_drawdown: 10,
      profit_target: 10,
      max_consecutive_losses: 0,
      consecutive_loss_daily_halt: 3,
      consistency_rule: 40,
      slippage_bps: 10,
      commission_pct: 0,
      spread_bps: 5,
    },
    regime_filter: {
      enabled: true,
      atr_period: 20,
      lookback_days: 90,
      percentile_floor: 0.3,
    },
    adx_filter: {
      enabled: true,
      adx_period: 14,
      min_adx: 20,
    },
    stagnant_exit: stagnantExit,
  };
  // Capital is used by some downstream sizing math; the search engine
  // doesn't need it here, but caller passes it through so the rule object
  // is self-contained and ready for `algorithms.insert()` if picked.
  void capital;
  return rules;
}

/**
 * Collect the unique set of timeframes referenced by a candidate batch.
 * Used by the search runner to decide which timeframe-specific price
 * series to pre-load. Cheap; called once per search run.
 */
export function collectCandidateTimeframes(candidates: Candidate[]): string[] {
  const set = new Set<string>();
  for (const c of candidates) {
    set.add(c.rules.timeframe);
    // Pattern conditions reference 1d / 4h higher-tf series; the
    // underlying portfolio backtest auto-resamples those from the
    // primary so the engine doesn't strictly need them pre-fetched,
    // but listing them keeps the price loader honest about coverage.
    for (const cond of c.rules.entry_conditions) {
      if ("timeframe" in cond && cond.timeframe) set.add(cond.timeframe);
    }
  }
  return Array.from(set);
}
