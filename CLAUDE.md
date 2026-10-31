@AGENTS.md

# QuantTrader

Personal autonomous trading system for one operator (not a SaaS). A deterministic engine scans XAU/USD 4h on a schedule, opens **paper** positions, and owns every exit, halt and size. Five rules-based algorithms run today; broker mirroring is **off** (`live_trading_enabled=false`). Goal: pass FTMO challenges. The LLM-trader entry path is dormant (Phase I.3, paid, last).

Where things stand, who decided what, and why: `scripts/canonical/ROADMAP.md` (research), `docs/STACK.md` (what runs where), `docs/DEBT.md` (known problems, ranked), `docs/CODE_QUALITY.md` (naming, structure, flows), `docs/decisions/` (why), `docs/DEV_SETUP.md` (every tool, one command each). The long-form notes this file used to hold are in `docs/PROJECT_CONTEXT.md` (reference, partly stale). An independent audit of the engine's claims is in progress on branch `review/skeptical-audit-2026-10`; the files it cites by line must not move or be reformatted until its verdict.

## Commands

```bash
make help              # every target
make check             # everything CI runs: lint, workflows, shell, typecheck, env, fence, db-types, tests
make backtest          # golden trade list; fails on any changed trade (make backtest-update to regenerate on purpose)
make lint-strict FILES=path/new.ts   # the target rule set; CI applies it to files added in a PR
make format            # prettier on changed files only (whole tree waits for the audit verdict)
make db-types          # regenerate Supabase types after a migration
make status            # VPS read-only view; prompts, as make deploy does — both only when the operator has asked (docs/DEV_SETUP.md §17)
pnpm dev               # http://localhost:3000 — scans and paper trading resume for every status='active' algo
```

pnpm only. Node is pinned by `.nvmrc`. `pnpm build` and `make check` before every PR.

## Rules that are enforced by tooling

- **Golden file.** `tests/golden/` pins every trade the engine produces for the five deployed algorithms on the pinned XAU/USD slice (39 at $100K, 17 at $10K). A change that alters a trade cannot merge unless the golden file is regenerated on purpose and the PR says which trades changed and why.
- **Pinned data is immutable.** `scripts/canonical/data/*-pinned.json` carry a sha-256 that is re-hashed on load; a new pin is a new file. Verdicts read pinned files, never the live `price_cache`.
- **Paper/live boundary.** `live_trading_enabled` gates only broker mirroring. `status='active'` scans and opens paper positions; zero activity needs `status='paused'`. Nothing in the live-runner paths (`.claude/hooks/live-paths.txt`: the scan engine, the broker adapters, every API route, the cron wrappers, the scripts they run, the deploy scripts) changes without a PR that says so in its title. Claude Code hooks refuse edits and shell writes there, and to `.env*`, pinned data and the golden inputs, by default; only the operator lifts the live-path fence, per session, and not before the audit verdict (`docs/decisions/0004`).
- **Secrets.** Never in the repo, never printed. `.env.local` holds them locally and on the VPS; `.env.example` lists every name. gitleaks runs pre-commit and in CI; GitHub secret scanning and push protection are on.
- **Strictness ratchets up.** The ESLint warning budget (`.eslint-warning-budget`) only goes down; new files meet `eslint.config.strict.mjs` from their first commit; known defects are `it.fails` tests that point at the audit or a DEBT id, never skipped tests or suppressions.
- **No attribution trailers.** Commit messages carry no `Co-Authored-By` or "Generated with" lines; a commit-msg hook rejects them.

## Git

- `dev` is the integration branch and what the VPS deploys; protected by the `protect-dev` ruleset (PR required, three CI checks, linear history). `main` is sorted out in Phase D.
- **One PR at a time against `dev`, one concern each, squash-merged.** Never stack PRs: a dependent change waits for its base to merge, then rebases (`docs/decisions/0002`).
- Branch names `tooling/…`, `feat/…`, `fix/…`. PRs under ~500 lines. Every PR updates the docs it affects (`docs/DEV_SETUP.md` for tooling, `docs/DEBT.md` for debt it adds or removes, `docs/decisions/` for a choice).

## Working here as Claude

- Read `docs/DEBT.md` D-01 to D-04 before touching the engine: three contracts exist in incompatible versions, errors are logged not raised, and the backtester and the live engine re-implement the same rules.
- The vocabulary is fixed: Strategy ≠ Algorithm (`algo` only as a local variable), ticker ≠ symbol (symbol only inside `src/lib/brokers/`), position ≠ trade, order only in broker adapters. Full glossary and the architecture gotchas: `docs/PROJECT_CONTEXT.md` (reference). Two that bite: server-side auth checks use `supabase.auth.getUser()`, never `getSession()`; a new protected route is added in three places (`middleware.ts`, `src/lib/supabase/middleware.ts`, the `(auth)/callback` whitelist).
- shadcn/ui here is the **base-nova** style over `@base-ui/react`: composition is `render={<Link />}`, never Radix `asChild`.
- Skills: `/validate` (run the validation harness), `/parity-check` (live-vs-backtest parity), `/regime-report`, `/ftmo-rules` (FTMO 2-Step Swing rules and R conventions). Agents: `skeptical-reviewer` (read-only review in a fresh context) and `backtest-runner`.
- Nothing that connects to a broker or writes to the live tables runs from a Claude session; the VPS is inspected read-only and only when the operator asks.
