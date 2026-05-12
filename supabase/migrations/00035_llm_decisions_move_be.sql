-- 00035 — allow 'move_be' on llm_decisions.decision
--
-- v4 / v5 / v5_15m prompts added a 5th decision option ('move_be') so
-- the LLM can lock in profit by moving SL to break-even mid-trade. The
-- Zod schema in src/lib/scan/llm-trader.ts was widened, but the DB
-- check constraint in 00031_llm_decisions.sql was not — every move_be
-- response from the live cron has been failing audit insert with:
--   new row for relation "llm_decisions" violates check constraint
--   "llm_decisions_decision_check"
-- Trading still proceeds (audit writes are best-effort), but we lose
-- the audit row for those bars.

alter table public.llm_decisions
  drop constraint if exists llm_decisions_decision_check;

alter table public.llm_decisions
  add constraint llm_decisions_decision_check
  check (decision in ('enter_long', 'enter_short', 'hold', 'exit', 'move_be'));
