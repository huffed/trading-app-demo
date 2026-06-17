-- 00043_backtest_trades.sql
--
-- Per-trade backtest results so /backtest can replay an algorithm's
-- historical trades. Only the LATEST run is kept per algorithm — a new
-- run for an algo DELETEs old rows first so we don't accumulate
-- stale runs.
--
-- Populated by runAlgorithmBacktestAction (user-triggered) and (in a
-- follow-up) by scripts/deploy-*.ts on initial deploy. LLM-trader algos
-- are intentionally skipped at the action layer to avoid budget churn —
-- the table is generic so we can flip that on later when the harness
-- pipeline supports it.

CREATE TABLE backtest_trades (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  algorithm_id       UUID            NOT NULL REFERENCES algorithms(id) ON DELETE CASCADE,
  run_at             TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  ticker             TEXT            NOT NULL,
  side               TEXT            NOT NULL CHECK (side IN ('long', 'short')),
  entry_date         TIMESTAMPTZ     NOT NULL,
  exit_date          TIMESTAMPTZ     NOT NULL,
  entry_price        NUMERIC         NOT NULL,
  exit_price         NUMERIC         NOT NULL,

  pnl                NUMERIC         NOT NULL,
  /** Optional per-trade R-multiple when SL info available at backtest
   *  time. Null when the algorithm has no structural SL or the engine
   *  doesn't surface it. */
  r_multiple         NUMERIC,
  exit_reason        TEXT,

  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backtest_trades_algorithm ON backtest_trades (algorithm_id, entry_date DESC);
CREATE INDEX idx_backtest_trades_user      ON backtest_trades (user_id);

ALTER TABLE backtest_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own backtest trades" ON backtest_trades
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users insert their own backtest trades" ON backtest_trades
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete their own backtest trades" ON backtest_trades
  FOR DELETE USING (auth.uid() = user_id);
