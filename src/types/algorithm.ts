// CB.M4 (2026-06-19 EVE): canonical path for the gate-config type is now
// `@/types/market-state-gate` (types-as-leaf). `lib/algorithm/market-state-gate`
// re-exports it for runtime call sites.
import type { MarketStateGateConfig } from "@/types/market-state-gate";

export type AlgorithmStatus = "draft" | "active" | "paused" | "archived";
export type RiskLevel = "conservative" | "moderate" | "aggressive";
export type IndicatorOperator = "less_than" | "greater_than" | "crosses_above" | "crosses_below";
export type SentimentOperator = "above" | "below" | "spike_above" | "spike_below";

// --- Discriminated union for conditions ---

export interface TechnicalCondition {
  type: "technical";
  indicator: string;
  operator: IndicatorOperator;
  value: number;
  timeframe: string;
}

export interface SentimentCondition {
  type: "sentiment";
  source: "news" | "social";
  metric: string;
  operator: SentimentOperator;
  threshold: number;
  topics?: string[];
  tickers?: string[];
  timeframe: string;
}

/**
 * ICT/SMC chart-pattern condition. Evaluated by the pattern detector
 * module (`lib/patterns`). Unlike technical conditions which compute on
 * an indicator series, patterns are detected directly from the bar OHLC.
 *
 * Supported patterns (initial set):
 *  - liquidity_sweep: pierce of a recent swing high/low + close back inside
 *  - fvg: 3-bar fair value gap created on the current bar
 *  - ifvg: a previous FVG that has been filled and is now retesting
 *  - daily_bias: higher-timeframe trend filter (D1 close vs N-period MA)
 *
 * Gold-only primitives (gated by dual-run validation — see
 * `lib/algorithm/dual-run-validator.ts` and `feedback_data_driven_gates`):
 *  - gold_session_window: bar UTC hour falls inside a named institutional
 *    session window (ny_killzone, silver_bullet, london_open, asian_session)
 *  - asian_range_break: directional break of the same-day Asian session
 *    (UTC 00:00-07:00) high/low with close confirmation
 *  - post_news_window: bar timestamp is X-Y minutes AFTER a high-impact
 *    economic release (positive signal — distinct from the news veto
 *    which BLOCKS trading 2 min ± news)
 */
export interface PatternCondition {
  type: "pattern";
  pattern:
    | "liquidity_sweep"
    | "liquidity_sweep_reclaim"
    | "fvg"
    | "ifvg"
    | "daily_bias"
    | "bos"
    | "choch"
    | "ote"
    | "equal_levels"
    | "order_block"
    | "engulfing"
    | "pin_bar"
    | "momentum"
    | "mean_reversion"
    | "gold_session_window"
    | "asian_range_break"
    | "post_news_window";
  /** Required directional alignment. Omit to match any direction. */
  direction?: "bullish" | "bearish";
  /** Lookback for swing-based patterns. Default 5. */
  lookback?: number;
  /** Period for the daily-bias MA. Default 20. */
  ma_period?: number;
  /** `gold_session_window` only. Named institutional flow window. */
  session?: "ny_killzone" | "silver_bullet" | "london_open" | "asian_session";
  /** `post_news_window` only. Inclusive lower bound, minutes after release. Default 5. */
  min_minutes_after?: number;
  /** `post_news_window` only. Exclusive upper bound, minutes after release. Default 30. */
  max_minutes_after?: number;
  /** `post_news_window` only. Minimum event impact to react to. Default "high". */
  min_impact?: "low" | "medium" | "high";
  timeframe: string;
}

export type EntryCondition = TechnicalCondition | SentimentCondition | PatternCondition;
export type ExitCondition = TechnicalCondition | SentimentCondition | PatternCondition;

/**
 * How multiple entry conditions combine.
 *  - "all": every condition must fire on the same bar (default, strictest)
 *  - "any": fires when any one condition is met (loosest)
 *  - { type: "n_of_m", n }: fires when at least n of the conditions are met
 */
export type EntryLogic = "all" | "any" | { type: "n_of_m"; n: number };

export function isTechnicalCondition(c: EntryCondition | ExitCondition): c is TechnicalCondition {
  return c.type === "technical";
}

export function isSentimentCondition(c: EntryCondition | ExitCondition): c is SentimentCondition {
  return c.type === "sentiment";
}

export function isPatternCondition(c: EntryCondition | ExitCondition): c is PatternCondition {
  return c.type === "pattern";
}

// --- Risk management & rules ---

export interface StopLoss {
  type: "percentage" | "fixed" | "pips" | "swing_anchor";
  /** For percentage/fixed/pips: the SL distance in those units. For
   *  swing_anchor: the ATR-multiple of the buffer added beyond the
   *  swing low/high (0 = SL exactly at the swing; 0.25 = SL is
   *  0.25×ATR beyond it). */
  value: number;
  /** swing_anchor only — bars to scan back for the swing extreme. Default 8. */
  lookback?: number;
  /** swing_anchor only — ATR period for the buffer calculation. Default 14. */
  atr_period?: number;
}

export interface TakeProfit {
  type: "percentage" | "fixed" | "pips" | "rr_multiple" | "prior_day_extreme";
  /** For percentage/fixed/pips: the TP distance in those units. For
   *  rr_multiple: the RR ratio (e.g. 2 = TP at 2× SL distance). For
   *  prior_day_extreme: the FALLBACK RR used when no valid level exists
   *  beyond entry (level = previous UTC day's low for shorts / high for
   *  longs — the liquidity pool price runs to; structural-TP screen
   *  2026-06-12: +0.54R vs rr1.5's +0.38R on n=134 recorded shorts). */
  value: number;
}

export interface PositionSizing {
  type:
    | "percentage_of_capital"
    | "fixed_amount"
    | "fixed_quantity"
    | "lots"
    | "risk_per_trade"
    | "conviction_scaled"
    | "vol_target";
  /**
   * Interpretation depends on type:
   *  - percentage_of_capital: % of equity (e.g. 16 → 16%)
   *  - fixed_amount: USD notional (e.g. 1000 → $1000 per trade)
   *  - fixed_quantity: raw units (shares for stocks)
   *  - lots: lot count (1 = 1 standard lot; 100k forex base or asset-class
   *    contractSize). Notional = lots × contractSize × price.
   *  - risk_per_trade: % of capital that hitting the SL would lose (e.g.
   *    1 → 1% risk). System auto-computes lot size from SL distance + asset
   *    cross-currency rates. Same algo config produces equivalent % returns
   *    on any account size — the strategy scales automatically.
   *  - conviction_scaled: BASE % risk (same shape as risk_per_trade) that
   *    gets multiplied by a conviction factor when more entry conditions
   *    align than the n_of_m threshold requires. Multiplier is linear:
   *    1× at the bare-minimum n hit, scaling up to `max_multiplier` when
   *    every condition fires. Encodes the friend's discretionary 20×
   *    sizing range (0.1 → 2.0 lots) systematically — 70% of his P&L
   *    came from his highest-conviction trades. Falls back to flat
   *    risk_per_trade behaviour for `all` / `any` entry_logic where
   *    "k of M conditions" isn't a meaningful conviction signal.
   *  - vol_target: target portfolio volatility, %. Position notional =
   *    `capital × value/100 / max(per_trade_R_std × instrument_vol_pct,
   *    min_vol_floor)`. Inverse-vol scaling: high-vol instrument → smaller
   *    position. Adapts to regime changes automatically without re-fitting
   *    the algo. `per_trade_R_std` is the rolling stddev of the algo's
   *    recent R-multiples (warmup fallback 1.0 used when fewer than 2
   *    historical trades); `instrument_vol_pct` is ATR(14)/price. Optional
   *    `min_vol_floor` (default 0.002) prevents explosive sizing on quiet
   *    bars. See `src/lib/algorithm/vol-target-sizing.ts` for the canonical
   *    implementation.
   */
  value: number;
  /**
   * `conviction_scaled` only. Cap on the conviction multiplier. Default 4
   * — never sizes more than 4× the base risk on a single trade. Friend's
   * actual range was 20× (0.1 → 2.0 lots) but we cap tighter so a
   * mis-tuned algorithm can't accidentally blow up on a strong-confluence
   * but still-losing day.
   */
  max_multiplier?: number;
  /**
   * `conviction_scaled` only. Which signal drives the conviction
   * multiplier. Default `"condition_count"` (current behaviour: scale
   * with k-above-n_of_m).
   *
   * `"tf_agreement"` scales with how many distinct timeframes in the
   * entry list have ≥1 firing condition. Anchored to multi-TF replay
   * data: ≥2-TF agreement = 61.5% WR vs 33% on single-TF. Use this on
   * templates where conditions span multiple timeframes; behaves
   * identically to `condition_count` for single-TF templates (no
   * agreement signal possible).
   */
  conviction_metric?: "condition_count" | "tf_agreement";
  /**
   * `vol_target` only. Denominator floor (dimensionless fraction; 0.002 =
   * 0.2%). Caps notional at `capital × value/100 / min_vol_floor` even
   * when raw `per_trade_R_std × instrument_vol_pct` goes below it. Default
   * 0.002 (= 25× capital ceiling at target_vol=5%).
   */
  min_vol_floor?: number;
  /**
   * `vol_target` only. Rolling-window length for per-trade R stddev.
   * Default 20 (DEFAULT_ROLLING_WINDOW in vol-target-sizing.ts). Smaller
   * = faster regime adaptation; larger = stabler.
   */
  rolling_window?: number;
}

export interface PropFirmRules {
  daily_loss_limit: number; // % of starting balance (e.g., 5)
  max_drawdown: number; // % of starting balance (e.g., 10)
  profit_target: number; // % evaluation target (e.g., 10)
  /**
   * Optional safety kill switch — count of consecutive losses that pulls
   * the bot off the platform. Not a published prop-firm rule; set to 0
   * to disable.
   */
  max_consecutive_losses: number;
  /**
   * Friend's "3 strikes" rule — soft halt that stops NEW entries for the
   * rest of the day after this many consecutive losing trades, but lets
   * existing positions run to their stops/TPs. Resets when the date
   * rolls over so the algo resumes next session. Different from
   * `max_consecutive_losses` which permanently kills the algo (intended
   * as the prop-firm hard safety net, not day-trading discipline).
   * 0 = disabled. Typical value 3.
   */
  consecutive_loss_daily_halt?: number;
  /**
   * Combined risk cap across all algos sharing the same broker connection
   * (live trading only). Pre-entry gate refuses new positions when the
   * sum of (currently open risk + this entry's risk) would exceed this %
   * of capital. Defaults to 3% — under FTMO's 5% DLL by enough margin
   * that simultaneous full-stop hits don't breach the daily survival
   * rule. Range 0.5-5%. Only relevant when ≥2 algos share one broker.
   * See lib/scan/risk-pool-halt.ts.
   */
  combined_risk_cap_pct?: number;
  /**
   * Whether `max_consecutive_losses` counts losing trades or losing days.
   * Pyramiding strategies should usually pick "days" so a single bad bar
   * closing 3 stacked positions doesn't blow 75% of the budget at once.
   */
  consecutive_loss_unit?: "trades" | "days";
  /**
   * Defensive halt threshold as a percentage of the daily-loss-limit.
   * The engine force-closes all positions when daily pnl reaches
   * `daily_loss_limit * (daily_loss_halt_pct / 100)`. 100 = halt at exact
   * DLL (no buffer); 80 = halt at 80% of DLL leaving 20% headroom for
   * intra-bar overshoot. Defaults to 100 for backwards compatibility.
   */
  daily_loss_halt_pct?: number;
  consistency_rule: number; // max % of total profit from single day (e.g., 40)
  slippage_bps: number; // basis points per trade (e.g., 10 = 0.1%)
  commission_pct: number; // % per trade (e.g., 0.1)
  /**
   * Broker spread cost per side in basis points. Separate from slippage:
   * spread is the fixed bid/ask gap the broker charges, slippage is the
   * variable cost from execution conditions. Both are deducted from each
   * fill. Defaults to 0 to preserve old backtest results; recommended
   * 3-10 bps for FTMO Demo on majors, higher on JPY crosses.
   */
  spread_bps?: number;
  /**
   * Commission in dollars per lot per round-turn (open + close combined).
   * Mirrors how prop firms / retail brokers actually charge: FTMO forex
   * majors are ~$7/lot, gold typically $7-10/lot. Applied additively to
   * `commission_pct` so an algo can be configured for either or both.
   * Defaults to 0 (no per-lot commission deducted from backtest pnl).
   * The backtest engine derives lot count from notional / contractSize,
   * so symbols without a contractSize entry skip the per-lot fee.
   */
  commission_per_lot?: number;
}

/**
 * News-window veto: blocks new entries inside [-before, +after] minutes
 * around economic events that affect the symbol's currencies. Highest-EV
 * use of news data per public-strategy research — strips out the
 * slippage/fake-fill losses common around CPI/NFP/FOMC.
 */
export interface NewsVetoRules {
  enabled: boolean;
  /** Block window minutes BEFORE the release. */
  block_minutes_before: number;
  /** Block window minutes AFTER the release. */
  block_minutes_after: number;
  /** Only events at or above this impact level fire the veto. */
  min_impact: "low" | "medium" | "high";
}

export interface AlgorithmRules {
  entry_conditions: EntryCondition[];
  /** Logic combining entry conditions. Defaults to "all" for backwards compat. */
  entry_logic?: EntryLogic;
  exit_conditions: ExitCondition[];
  /**
   * Logic combining exit conditions. Falls back to entry_logic when
   * undefined so legacy algos preserve their behaviour. New algos default
   * to "any" via clampRules — typical exit semantics fire on the first
   * confirming signal rather than waiting for all to align.
   */
  exit_logic?: EntryLogic;
  stop_loss: StopLoss;
  take_profit: TakeProfit;
  /** Per-side TP override — applied to SHORT entries only. Gold falls
   *  fast then reverses (short-geometry screen 2026-06-12, n=134:
   *  shorts at rr1.5 earn +46% more R than at the symmetric rr3, while
   *  longs need the rr3 room). Absent = symmetric take_profit. Resolved
   *  via takeProfitRuleForSide() in structural-sl.ts. */
  take_profit_short?: TakeProfit;
  position_sizing: PositionSizing;
  max_positions: number;
  /** Pyramiding cap per symbol. Defaults to 1 (no stacking). */
  max_per_ticker?: number;
  /**
   * Account leverage ratio for margin calculations. Only matters when
   * position_sizing.type === "lots". 30 = 30:1 (default), 100 = 100:1
   * (typical FTMO forex). Backwards compatible: omitted = unlimited
   * margin (legacy non-leveraged behaviour).
   */
  leverage?: number;
  timeframe: string;
  asset_class: string;
  /**
   * Trade direction the algorithm commits to:
   *  - "long" / "short": fixed bias, default "long".
   *  - "auto": regime-adaptive — at each entry the engine reads the
   *    higher-timeframe bias on the ticker and trades that direction.
   *    Pattern conditions' configured `direction` filter is overridden
   *    to match the active bias for that bar, so a single algo trades
   *    longs in bullish regimes and shorts in bearish regimes on the
   *    same pair without reconfiguration. Skips entry when D1 is neutral.
   */
  side?: "long" | "short" | "auto";
  prop_firm?: PropFirmRules;
  news_veto?: NewsVetoRules;
  /**
   * Cumulative paper-vs-broker divergence kill switch. Computes the rolling
   * mean of |broker_fill_price - entry_price| in basis points (bp = 0.01%
   * of price) across the last N entries with a recorded broker fill. When
   * the mean exceeds the limit AND we have at least N samples, live trading
   * is disabled on the algorithm. Backtests assume 10 bp slippage; defaults
   * are tuned to flag "real fills are materially worse than the model".
   */
  divergence_kill?: {
    /** Average absolute divergence threshold in bps (e.g., 20 = 0.20%). */
    max_avg_bps: number;
    /** Window size in trades. Lower = faster reaction, more variance. */
    window_trades: number;
  };
  /**
   * Volatility-regime gate: skip entries when 20-period ATR drops below
   * a percentile floor of its recent distribution. Choppy / compressed
   * tape historically whipsaws our pattern strategies before TPs can
   * develop — testing 3's Sep/Mar/Feb 0% WR months were all in the
   * bottom-30th-percentile ATR regime.
   */
  regime_filter?: {
    enabled: boolean;
    /** Periods for the ATR average. Default 20. */
    atr_period?: number;
    /** Lookback bars used to build the percentile distribution. Default 90. */
    lookback_days?: number;
    /** Skip when current ATR is below this percentile (0..1). Default 0.30. */
    percentile_floor?: number;
  };
  /**
   * Trend-strength gate using ADX. Skips entries when ADX is below the
   * minimum threshold — i.e. there's no clear directional trend. ATR-
   * percentile didn't work because low ATR ≠ ranging; ADX directly
   * measures whether bulls or bears are in control.
   */
  adx_filter?: {
    enabled: boolean;
    /** ADX lookback period. Default 14. */
    adx_period?: number;
    /** Minimum ADX to allow entries. Default 20 (below = ranging). */
    min_adx?: number;
  };
  /**
   * Data-driven time-of-day filter. Refuses entries during hours whose
   * historical win rate (computed from this algorithm's own closed
   * paper positions) is below `min_wr_pct`. Empirical — not a clock
   * window. Falls back to no-op until each hour bucket has ≥
   * `min_samples` closed trades; new algorithms can trade any hour
   * during the warm-up period and the filter activates per-hour as
   * data accumulates.
   */
  time_filter?: {
    enabled: boolean;
    /** Minimum WR % required to allow entries during an hour. Default 45. */
    min_wr_pct?: number;
    /** Min closed trades per hour bucket to count as informative. Default 5. */
    min_samples?: number;
    /** Optional days-back window for stats. Older trades may reflect a
     *  different regime; capping the lookback keeps the filter responsive. */
    window_days?: number;
  };
  /**
   * Stagnant-loser early exit. Closes a position open ≥ N bars that
   * never reached `min_excursion_r` favourable excursion AND is still
   * sitting at or below `min_pnl_r`. Encodes the friend's "cut what
   * isn't working" discipline. `max_bars` is auto-derived from local
   * ATR when undefined: `clamp(round(SL_distance / ATR(14) * 0.5), 2, 12)`.
   * The auto formula adapts per timeframe / symbol / volatility regime;
   * pin a number explicitly only when an algo wants override.
   */
  stagnant_exit?: {
    enabled: boolean;
    max_bars?: number;
    /** R-units. Default 0.5. */
    min_excursion_r?: number;
    /** R-units. Default 0. */
    min_pnl_r?: number;
  };
  /**
   * Trailing stop — ratchets the SL up (long) / down (short) as price
   * moves favourably, locking in profit when the trend reverses.
   * Activates only after the position's MFE (max favourable excursion)
   * crosses `activate_at_r` to avoid stopping out on noise. Once
   * active, SL trails at `trail_distance_r` behind the current price.
   * Never backsteps — only ratchets in the favourable direction.
   *
   * Solves the "TP never fires" structural issue with our 1h algos:
   * backtest data shows the 3.6% TP on 1h gold momentum has 0% hit rate
   * over hundreds of trades. Trailing stops let the position ride a
   * sustained move and lock in profit when momentum exhausts, instead
   * of waiting for a fixed TP that never gets reached.
   */
  trailing_stop?: {
    enabled: boolean;
    /** R-units of favourable excursion before the trailing stop arms.
     *  Default 0.5 — half the SL distance. Below this, the position
     *  uses its original SL untouched. */
    activate_at_r?: number;
    /** R-units the trailing SL sits behind the current price once
     *  armed. Default 1.0 — same magnitude as the original SL distance.
     *  Larger = lets winners run further; smaller = locks in faster. */
    trail_distance_r?: number;
    /** ATR-units variant (2026-06-16): trail anchored on absolute
     *  volatility (ATR(14) at entry) rather than each trade's
     *  swing-anchor SL distance. If either ATR-field is set, the
     *  ATR variant takes precedence over the R variant in
     *  updateTrailingState. Trend-followers' winners reach 9-17 ATR
     *  favorable; ATR-anchored trail captures that tail more
     *  directly than R-based for wide-swing SLs that vary per trade. */
    activate_at_atr?: number;
    trail_distance_atr?: number;
  };
  /**
   * Breakeven SL move — once the position's MFE crosses `trigger_at_r`,
   * the SL ratchets up (long) / down (short) to the entry price.
   * Removes the original loss potential; subsequent SL hits realise
   * zero or near-zero P&L. Pairs with trailing_stop: breakeven first,
   * then trail behind further favourable moves.
   */
  breakeven_move?: {
    enabled: boolean;
    /** R-units of favourable excursion that triggers the SL move to
     *  entry. Default 1.0 — full R favourable. Tighter (0.5) is more
     *  defensive but cuts more recoveries; looser (1.5) preserves more
     *  winners but exposes more capital. */
    trigger_at_r?: number;
  };
  /**
   * DXY directional filter — refuses gold entries when the dollar index
   * direction over the lookback window opposes the proposed trade side.
   * EUR/USD is used as the DXY proxy (Twelve Data has no DXY symbol;
   * EUR/USD is 57% of the basket and strongly inversely correlated).
   *
   * Per-algo, not blanket: empirically validated with material positive
   * impact on the 15m short gold algo (Algo B) — 86% WR / +$2,124 avg
   * for DXY-aligned trades vs 28% / -$250 for DXY-against. Signal is
   * mixed or inverted on the 1h long algos; do not enable elsewhere
   * without re-running inspect-algo overlay first.
   */
  dxy_filter?: {
    enabled: boolean;
    /** Hours of EUR/USD direction to evaluate before each candidate
     *  entry. Default 12. Shorter windows track intraday flow; longer
     *  windows reflect session-spanning bias. */
    lookback_hours?: number;
    /** Minimum |EUR/USD pip change| over the lookback to count as
     *  directional. Below this counts as neutral. Default 15. */
    pip_threshold?: number;
    /**
     * Which buckets the filter blocks. Three options correspond to
     * three observed empirical patterns on gold long-corpus inspect runs:
     *  - "block_against": classic — block trades fighting the dollar
     *    direction. Validated for Algo B (15m short, 86% WR aligned vs
     *    28% against).
     *  - "block_neutral_only": risk-reduction mode. On Algo D's long
     *    corpus (XAU/USD 1h momentum), block_against destroys ~$6K
     *    expectancy with no WR change — against-DXY entries carry
     *    positive EV (likely mean-reversion). Blocking only the neutral
     *    mid-range preserves return and reduces max DD ~1.5pp at the
     *    12h × 15pip default and ~3pp at 24h × 30pip.
     *  - "block_against_and_neutral": most aggressive — only allow
     *    strongly-DXY-aligned entries.
     * Default "block_against" preserves PR-95 behaviour when unset.
     */
    mode?: "block_against" | "block_neutral_only" | "block_against_and_neutral";
    /** Legacy — when true and `mode` is unset, behaves as
     *  "block_against_and_neutral". Kept for backwards compatibility
     *  with rules persisted before mode was added. */
    block_neutral?: boolean;
  };

  /**
   * LLM-trader mode — discretionary AI trader instead of pattern-detect +
   * threshold. When enabled, the scan engine bypasses entry_conditions /
   * exit_conditions evaluation and routes the decision to an LLM call
   * with rich market context (daily bias, recent bars, intermarket).
   *
   * Validated on Anthropic Haiku 4.5 across three non-overlapping 60d
   * historical windows: 20 trades, 65% WR, +$20,217 (+20.2%), 0.75% peak
   * DD on XAU/USD 4h. See `feat/llm-trader-mvp` branch + project memory
   * `project_current_state.md` for full validation evidence.
   *
   * Other adaptive gates (intraday ATR, regime, ADX, news veto, consec-
   * loss halt, FTMO consistency, drift detector, position-size sanity)
   * still apply on top of LLM decisions — the LLM determines direction
   * and timing, the gates determine whether to honour or refuse the
   * decision.
   */
  llm_trader?: {
    enabled: boolean;
    /** Which provider to use. anthropic = Haiku (validated baseline);
     *  groq = llama (cheaper but exhibited cliché-matching in early
     *  tests, may improve with prompt iteration). */
    provider: "anthropic" | "groq";
    /** Override the default model. Anthropic default = claude-haiku-4-5;
     *  groq default = llama-3.3-70b-versatile. */
    model?: string;
    /** Prompt version tag.
     *  - "v1": frozen baseline. Validated 5/6 WF green / 57% WR / +15.8%.
     *    HH→RANGING transitions: 2/2 losers (the iteration target).
     *  - "v2": v1 + reframed →RANGING transition. Default action becomes
     *    EXIT; LLM may override only with an articulated structural reason.
     *  - "v3": scalper variant for 30m / 15m. Loosened triggers, lower
     *    conviction threshold, session-time awareness, framed for 0.5%
     *    SL / 1.5% TP. Use with TIMEFRAME=30m or 15m algos.
     *  - "v4": short-term swing variant for 30m. v3 reframed as "let
     *    winners run" + adds "move_be" decision (LLM-judged break-even
     *    SL move) + framed for STRUCTURAL SL/TP (swing_anchor + rr_multiple
     *    in algo rules), not fixed %.
     *  - "v5": v4 + multi-TF override. D1 disagreeing with both 1h+4h
     *    flips the regime read (catches transition rallies D1 lags on).
     *    Pair with TIMEFRAME=30m. Validated +59% lift vs v3 across 4
     *    windows / -2.15% avg DD vs -5.46%.
     *  - "v5_15m": v5 base adapted to 15m primary. Higher TFs become
     *    30m + 1h (vs v5's 1h + 4h on 30m primary). Tighter momentum
     *    triggers (+0.25% vs +0.4%), 3-8 bar setup window (vs 4-12),
     *    explicit London/NY-open emphasis where 15m's edge concentrates.
     *  - "v2_mtf": v2 base + multi-TF transition override. Engine wires
     *    1h higher-TF context (4h primary → 1h secondary). Prompt
     *    permits TRANSITION-mode entries when D1 lags a 1h-confirmed
     *    reversal. Targets the D1 detection lag identified 2026-05-15
     *    (Feb 2-6 missed cluster: 12% reversal while D1 read LH).
     *  - "v2_generic": v2 stripped of gold-specific framing. Built
     *    2026-05-18 for Phase 0 of the architecture rebuild's
     *    multi-instrument viability test. Same triggers/regime rules
     *    as v2 but no "gold (XAU/USD)" framing and no gold-specific
     *    intermarket guidance — LLM interprets per instrument. Engine
     *    auto-skips commodity intermarket for non-commodity tickers
     *    and uses EUR/USD as DXY proxy for non-EUR/USD pairs.
     *  Defaults to v2 in production when unspecified. */
    prompt_version?: "v1" | "v2" | "v2_generic" | "v2_mtf" | "v3" | "v4" | "v5" | "v5_15m";
    /** Dry-run: log the LLM's decision to activity_log but do NOT
     *  actually open/close positions. Used for the first 1-2 cycles of
     *  live deployment to verify the LLM behaves sensibly on real-time
     *  data before trusting it with capital. Default false (live). */
    dry_run?: boolean;
  };
  /**
   * Drift detector overrides. Tier 1 of Phase 7 learning loop. Drift
   * detector by default halts when recent live WR drops ≥20pp below
   * backtest baseline. For R-asymmetric strategies (low backtest WR
   * + high RR) this rule alone lets the algo bleed past breakeven —
   * set `min_live_wr_pct` as an absolute floor.
   *
   * Example: Intraday's 30% baseline with 3:1 RR has breakeven at
   * ~25% WR. Set min_live_wr_pct=22 to halt before going negative-EV
   * (rather than the default <10% drift threshold which is below
   * breakeven by ~15pp).
   */
  drift?: {
    /** Absolute floor on live WR (percent). Halt fires when recent WR
     *  drops below this regardless of baseline. Bounds: 5-80. */
    min_live_wr_pct?: number;
  };
  /**
   * Regime-library dormancy gate. Declares the market states this
   * algorithm may enter in; the engine evaluates it every tick against
   * the live-computed MarketState, BEFORE any LLM spend, and only when
   * flat. Strategies wake and sleep with the regime — never via manual
   * toggling. See src/lib/algorithm/market-state-gate.ts.
   */
  market_state_gate?: MarketStateGateConfig;
}

// --- Backtest results ---

export interface BacktestResults {
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  win_rate: number;
  equity_curve: { date: string; value: number }[];
}

// --- Algorithm entity ---

export interface Algorithm {
  id: string;
  user_id: string;
  name: string;
  description: string;
  asset_class: string;
  risk_level: RiskLevel;
  time_horizon: string;
  capital: number;
  user_hints: string | null;
  rules: AlgorithmRules;
  ai_analysis: string | null;
  backtest_results: BacktestResults | null;
  status: AlgorithmStatus;
  last_scanned_at: string | null;
  // Live trading wiring (Phase B)
  live_trading_enabled?: boolean;
  broker_connection_id?: string | null;
  /** Optional portfolio grouping — when set, the portfolio's halt rules
   *  apply to this algo. ON DELETE SET NULL on the portfolio. */
  portfolio_id?: string | null;
  /** Account leverage ratio used for margin calculations on lots-sized algos.
   *  Mirrors AlgorithmRules.leverage so backtest + live agree. */
  leverage?: number;
  /** Cutoff timestamp for drift / pair-quality calculations. Trades closed
   *  before this point are excluded so a fix-driven baseline reset doesn't
   *  poison the rolling metrics. */
  metrics_reset_at?: string | null;
  /** Optional strategy umbrella (migration 00042). Null = standalone algo.
   *  Set: this algo is an instance of a strategy template. A4-stage UI
   *  groups instances by strategy. Scan engine still reads algorithms.rules
   *  directly; merged-rules consumption is A3 (deferred). */
  strategy_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Strategy umbrella (migration 00042 + seed PR #266). One row per
 *  family (FVG-DailyBias, Dip-Buyer, Coil-Breakout, etc.); each
 *  algorithm instance points back via algorithms.strategy_id. */
export interface Strategy {
  id: string;
  user_id: string;
  name: string;
  description: string;
  /** Shared rules template — merged with per-instance algorithms.rules
   *  at scan time once A3 ships. Currently informational. */
  rules_template: Record<string, unknown>;
  status: AlgorithmStatus;
  created_at: string;
  updated_at: string;
}

export type AlgorithmInsert = Omit<
  Algorithm,
  "id" | "user_id" | "ai_analysis" | "backtest_results" | "created_at" | "updated_at"
>;

export type AlgorithmUpdate = Partial<AlgorithmInsert>;
