-- 00026 — Pro-account preferences on profiles
--
-- Wave 4 surfaces two new operator-level preferences:
--
--   prop_firm_preset — which preset (FTMO / FundedNext / Topstep / The5ers
--     / custom) to use as the default when generating new algorithms.
--     Today the chat / form picks ad-hoc; this gives the operator a
--     single source of truth that persists across new algos. Null = no
--     preset (retail / unconstrained).
--
--   autonomy_level — paper_only / suggest / semi_auto / full_auto. Stored
--     here so future flows (live execution gates, signal-only mode,
--     manual approval per trade) have a single user-level setting to
--     consult instead of re-deriving from algorithm rules. Defaults to
--     paper_only because that's the currently-active mode and we don't
--     want a missing column to mean "auto-go-live".
--
-- Both are nullable text + CHECK to constrain values; expansion is a
-- migration (intentional — adding a new prop firm or autonomy mode
-- needs a code change too).

alter table public.profiles
  add column if not exists prop_firm_preset text
    check (prop_firm_preset is null
        or prop_firm_preset in ('ftmo', 'topstep', 'funded_next', 'the5ers', 'custom'));

alter table public.profiles
  add column if not exists autonomy_level text not null default 'paper_only'
    check (autonomy_level in ('paper_only', 'suggest', 'semi_auto', 'full_auto'));
