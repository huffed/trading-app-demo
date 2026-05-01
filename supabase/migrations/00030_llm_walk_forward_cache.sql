-- 00030 — LLM-trader walk-forward cache column
--
-- LLM-trader algorithms can't be exercised by the standard runWalkForward
-- (their entry_conditions are empty by design — the LLM determines
-- entries). The dedicated walk-forward orchestrator
-- `scripts/llm-trader-walk-forward.ts` runs the LLM through rolling
-- windows; the result is expensive (~$1 + ~12 min per run) so we cache
-- it on the algorithm row instead of re-running every time the
-- readiness button is clicked.
--
-- Shape stored here mirrors the WalkForwardSummary the readiness check
-- consumes, plus provenance metadata (provider, model, prompt_version,
-- window_days, end_date) so a stale cache can be detected and refreshed.
--
-- NULL when no LLM walk-forward has been run for this algorithm.
-- Non-LLM algos leave it NULL — the standard runWalkForward path is
-- unchanged.

alter table public.algorithms
  add column if not exists llm_walk_forward_cache jsonb;

comment on column public.algorithms.llm_walk_forward_cache is
  'Cached LLM walk-forward summary. Populated by scripts/llm-trader-walk-forward.ts when ALGO_ID is set. Read by runReadinessCheck for algorithms with rules.llm_trader.enabled=true.';
