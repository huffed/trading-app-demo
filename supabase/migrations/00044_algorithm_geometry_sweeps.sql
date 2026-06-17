-- 00044_algorithm_geometry_sweeps.sql
--
-- Persisted RR × lookback geometry sweep results per algorithm. Each
-- algorithm has at most ONE sweep row (the most recent run); a new
-- run for an algo does DELETE-then-INSERT.
--
-- Populated by runGeometrySweepAction (UI Run button on
-- /algorithms/[id]/validate). For each cell in the 3×3 grid
-- (rr ∈ {2,3,5} × lookback ∈ {3,4,6}) the action clones the algo's
-- rules with that geometry, runs the backtest engine across full
-- history (with prop_firm enforced — same as the deployed live
-- config), and stores aggregate stats + per-year breakdown in the
-- `cells` JSONB.
--
-- Cells JSONB shape:
--   { cells: [
--       { rr, lookback, total_return, max_drawdown,
--         total_trades, win_rate, dd_breached,
--         per_year: { "2020": {trades, return, win_pct}, ... } },
--       ...
--     ],
--     grid: { rr: [2,3,5], lookback: [3,4,6] },
--     ran_at: ISO,
--   }

CREATE TABLE algorithm_geometry_sweeps (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  algorithm_id  UUID         NOT NULL REFERENCES algorithms(id) ON DELETE CASCADE,
  ran_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cells         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One sweep per algo at a time.
CREATE UNIQUE INDEX idx_geometry_sweeps_algo ON algorithm_geometry_sweeps (algorithm_id);
CREATE INDEX idx_geometry_sweeps_user        ON algorithm_geometry_sweeps (user_id);

ALTER TABLE algorithm_geometry_sweeps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own geometry sweeps" ON algorithm_geometry_sweeps
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert their own geometry sweeps" ON algorithm_geometry_sweeps
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete their own geometry sweeps" ON algorithm_geometry_sweeps
  FOR DELETE USING (auth.uid() = user_id);
