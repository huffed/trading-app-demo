/**
 * Engine defaults applied when an algorithm's rules omit the corresponding
 * field. Centralized here so the single-symbol backtest, portfolio backtest,
 * and any future runner agree on the same fallbacks.
 */
export const DEFAULT_MAX_POSITIONS = 1;
export const DEFAULT_POSITION_SIZE_PCT = 10;
export const DEFAULT_STOP_LOSS_PCT = 5;
export const DEFAULT_TAKE_PROFIT_PCT = 15;
