-- Per-algorithm metrics reset point. When set, the drift detector and
-- pair-quality evaluator filter paper_positions to closed_at >= this
-- timestamp. Lets the user "forgive" a known bug-induced trade
-- (e.g. the 2026-04-27 CHF/JPY catalog blow-up) without deleting
-- history — keeps the activity log honest while letting safety
-- halts evaluate against post-fix data only.
alter table algorithms
  add column if not exists metrics_reset_at timestamp with time zone;

comment on column algorithms.metrics_reset_at is
  'When set, drift detection and pair-quality evaluation only consider closed trades with closed_at >= this timestamp. Used after a known sizing/config bug to prevent bad data from triggering safety halts on the corrected algorithm.';
