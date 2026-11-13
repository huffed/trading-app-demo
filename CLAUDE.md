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

- **Golden file.** `tests/golden/` pins every trade the backtester produces for the five deployed algorithms on the pinned slice (39 at $100K, 17 at $10K); the live engine (`src/lib/scan`) is not covered until E0 (`docs/MODERNISATION.md`). A change that alters a trade cannot merge unless the golden file is regenerated on purpose and the PR says which trades changed and why.
- **Pinned data is immutable.** `scripts/canonical/data/*-pinned.json` carry a sha-256 that is re-hashed on load; a new pin is a new file. Verdicts read pinned files, never the live `price_cache`.
- **Paper/live boundary.** `live_trading_enabled` gates only broker mirroring. `status='active'` scans and opens paper positions; zero activity needs `status='paused'`. Nothing in the fenced live paths (`.claude/hooks/live-paths.txt`: the trading code — engine, runner, strategies, risk, sizing, execution, the engine's migrations, the paper engine's price config, the cron wrappers and the scripts they run; exact list in `docs/decisions/0006`) changes without a PR that says so in its title. Claude Code hooks refuse edits and shell writes there, and to `.env*`, pinned data and the golden inputs, by default; only the operator lifts the live-path fence, per session, and not before the audit verdict (`docs/decisions/0004`, `0006`). Infrastructure (`ops/**`, `scripts/ops/**`) is not fenced; it is covered by shellcheck, CI, review and the operator's approval of every host command.
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
- No session acts on a broker account — places, modifies or closes orders, or changes account settings — except `make kill-switch`, which may flatten mirrored positions, and, once mirroring is on, `make resume` and `make unpause`, which together let the engine trade again; read-only broker access is allowed, and `REDEPLOY=1` without `APPLY=1` on `scripts/canonical/metaapi-connection-doctor.ts` is infrastructure: it prompts every time, is never pre-approved, gets a ledger row, and does not run while mirroring is on until an incident runbook exists (decision 0010). No session writes to the live tables except through `make kill-switch`, `make resume` and `make unpause`, each of which prompts every time, is never pre-approved, prints the mirroring state and writes a ledger row (`docs/runbooks/kill-switch.md`, decision 0010); like every host command, they run only when the operator asks. Otherwise the VPS is inspected read-only.

## Working with the operator

Decision 0013. The operator can only answer what they can see is blocked.

- **Questions go at the end of a turn only,** under the heading **BLOCKED ON YOU**, numbered, each with a recommended answer. The same message says what the session carries on with meanwhile, and the session does it.
- **No turn ends with the session's own work outstanding** unless its last line names the next action and who starts it.
- **The operator's queue order stands.** The session's own findings go to the end of the queue as proposals.
- **Every claim about how a tool behaves says what was run to check it.**
- **Merges.** The session does not run `gh pr merge` on its own. A PR that is review-clean and green goes on the **READY TO MERGE** list at the end of the turn, with its number and head commit, and the session moves on to the next independent item. When the operator says "merge the queue", the session merges each listed PR in order, after checking that it is still green at the listed head. `protect-dev` requires a branch to be up to date with `dev`, so once one PR merges the next is rebased onto `dev`. It is merged when the rebase applied without a conflict and CI is green at the new head; otherwise it goes back on the list with the reason.
- **Review rounds.**
  - A docs PR with no runnable command (DEBT rows, decisions, ledger text) gets one fresh review. It is review-clean when that review reports no Critical or High; Medium and Low findings are fixed in the same push, with no further round. A Critical or High is fixed, and the fix gets one more fresh review under the same rule.
  - Runbooks, plans with host commands, code and tooling keep the review loop until a review is clean.
- **Being visible.**
  - Sessions start with `caffeinate -is claude`.
  - The Notification hook pushes a permission prompt left unanswered for about 6 s, and an idle wait of about 60 s, to the operator's phone; `docs/DEV_SETUP.md` §16 lists what it misses.
  - Claude Code discards anything that hook prints. So before a turn ends with BLOCKED ON YOU, the session reads the last line of `~/.local/state/quanttrader/notify.log` and says so in the turn if the last push was not sent.
