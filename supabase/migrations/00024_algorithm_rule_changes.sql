-- 00024 — Algorithm rule-change audit log
--
-- updateAlgorithm() previously accepted unvalidated rules and wrote them
-- straight to the algorithms table. Live trading on a corrupted rule set
-- could lose real money silently. This table captures every
-- updateAlgorithm() call that touched the rules JSONB so we can:
--   1. Reject malformed rules at the action boundary (Zod-validated)
--   2. Reconstruct what changed, when, and through which surface
--   3. Roll back by replaying earlier `before` snapshots if needed
--
-- Append-only — no UPDATE/DELETE policy. RLS scopes to the owner.

create table public.algorithm_rule_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  algorithm_id uuid not null references public.algorithms(id) on delete cascade,
  changed_at timestamptz not null default now(),

  -- Which surface initiated the change. "chat" = LLM marker via use-chat.ts;
  -- "ui" = AlgorithmEditView form; "api" = direct server-action call.
  source text not null check (source in ('chat', 'ui', 'api')),

  -- Which top-level fields differed in this update (e.g. ['rules', 'status']).
  fields_changed text[] not null default array[]::text[],

  -- Full before/after snapshots of the affected updates payload. Stored
  -- pre-clamp/post-clamp so we can see what the LLM emitted vs what we
  -- persisted after clampRules / schema normalization.
  before jsonb not null default '{}',
  after  jsonb not null default '{}'
);

create index idx_algorithm_rule_changes_algo_changed
  on public.algorithm_rule_changes (algorithm_id, changed_at desc);

create index idx_algorithm_rule_changes_user_changed
  on public.algorithm_rule_changes (user_id, changed_at desc);

alter table public.algorithm_rule_changes enable row level security;

create policy "Users view own rule changes"
  on public.algorithm_rule_changes for select
  using (auth.uid() = user_id);

create policy "Users insert own rule changes"
  on public.algorithm_rule_changes for insert
  with check (auth.uid() = user_id);
