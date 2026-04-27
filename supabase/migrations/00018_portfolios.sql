-- Portfolios = the prop-firm account container. Multiple algorithms can be
-- linked to one portfolio, sharing capital and prop-firm risk rules.
-- Daily-loss halt and drawdown tracking will fire at portfolio level so a
-- losing day on one algo flattens the others before FTMO closes the account.

create extension if not exists "pgcrypto";

create table if not exists portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  broker_connection_id uuid references broker_connections(id) on delete set null,
  capital numeric not null default 100000 check (capital > 0),
  -- Same shape as algorithms.rules.prop_firm — copied here so the portfolio
  -- defines the rules and individual algos inherit. JSONB for flexibility.
  prop_firm_rules jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One portfolio per (user, name).
  unique (user_id, name)
);

create index if not exists portfolios_user_id_idx on portfolios (user_id);
create index if not exists portfolios_broker_idx on portfolios (broker_connection_id);

alter table algorithms
  add column if not exists portfolio_id uuid references portfolios(id) on delete set null;

create index if not exists algorithms_portfolio_id_idx on algorithms (portfolio_id);

-- RLS — owner-only read/write.
alter table portfolios enable row level security;

drop policy if exists "Users access their own portfolios" on portfolios;
create policy "Users access their own portfolios"
  on portfolios for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Maintain updated_at on portfolio writes.
create or replace function portfolios_set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists portfolios_set_updated_at on portfolios;
create trigger portfolios_set_updated_at
  before update on portfolios
  for each row execute function portfolios_set_updated_at();
