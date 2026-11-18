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

- **Golden file.** `tests/golden/` pins every trade the backtester produces for the five deployed algorithms on the pinned slice (39 at $100K, 17 at $10K); the live engine (`src/lib/scan`) is not covered until E0 (`docs/MODERNISATION.md`), whose tests may land before the audit verdict (decision 0014). A change that alters a trade cannot merge unless the golden file is regenerated on purpose and the PR says which trades changed and why.
- **Pinned data is immutable.** `scripts/canonical/data/*-pinned.json` carry a sha-256 that is re-hashed on load; a new pin is a new file. Verdicts read pinned files, never the live `price_cache`.
- **Paper/live boundary.** `live_trading_enabled` gates only broker mirroring. `status='active'` scans and opens paper positions; zero activity needs `status='paused'`. Nothing in the fenced live paths (`.claude/hooks/live-paths.txt`: the trading code — engine, runner, strategies, risk, sizing, execution, the engine's migrations, the paper engine's price config, the cron wrappers and the scripts they run; exact list in `docs/decisions/0006`) changes without a PR whose title says `[changes fenced live paths]`; the `live-path fence` CI job fails a PR into `dev` that changes one unless that marker is in the title and `review/VERDICT.md` is already on `dev` (`docs/decisions/0015`). Claude Code hooks refuse edits and shell writes there, and to `.env*`, pinned data and the golden inputs, by default; only the operator lifts the live-path fence, per session, and not before the audit verdict (`docs/decisions/0004`, `0006`). Infrastructure (`ops/**`, `scripts/ops/**`) is not fenced; it is covered by shellcheck, CI, review and the operator's approval of every host command.
- **Secrets.** Never in the repo, never printed. `.env.local` holds them locally and on the VPS; `.env.example` lists every name. gitleaks runs pre-commit and in CI; GitHub secret scanning and push protection are on.
- **Strictness ratchets up.** The ESLint warning budget (`.eslint-warning-budget`) only goes down; new files meet `eslint.config.strict.mjs` from their first commit; known defects are `it.fails` tests that point at the audit or a DEBT id, never skipped tests or suppressions.
- **No attribution trailers.** Commit messages carry no `Co-Authored-By` or "Generated with" lines; a commit-msg hook rejects them.

## Git

- `dev` is the integration branch and what the VPS deploys; protected by the `protect-dev` ruleset (PR required, three CI checks, linear history). `main` is sorted out in Phase D.
- **One concern per PR against `dev`, squash-merged.** Several independent PRs may be open at once. Never stack PRs: a dependent change waits for its base to merge, then rebases (`docs/decisions/0002`).
- Branch names `tooling/…`, `feat/…`, `fix/…`. PRs under ~500 lines. Every PR updates the docs it affects (`docs/DEV_SETUP.md` for tooling, `docs/DEBT.md` for debt it adds or removes, `docs/decisions/` for a choice).

## Working here as Claude

- Read `docs/DEBT.md` D-01 to D-04 before touching the engine: three contracts exist in incompatible versions, errors are logged not raised, and the backtester and the live engine re-implement the same rules.
- The vocabulary is fixed: Strategy ≠ Algorithm (`algo` only as a local variable), ticker ≠ symbol (symbol only inside `src/lib/brokers/`), position ≠ trade, order only in broker adapters. Full glossary and the architecture gotchas: `docs/PROJECT_CONTEXT.md` (reference). Two that bite: server-side auth checks use `supabase.auth.getUser()`, never `getSession()`; a new protected route is added in three places (`middleware.ts`, `src/lib/supabase/middleware.ts`, the `(auth)/callback` whitelist).
- shadcn/ui here is the **base-nova** style over `@base-ui/react`: composition is `render={<Link />}`, never Radix `asChild`.
- Skills: `/validate` (run the validation harness), `/parity-check` (live-vs-backtest parity), `/regime-report`, `/ftmo-rules` (FTMO 2-Step Swing rules and R conventions). Agents: `skeptical-reviewer` (read-only review in a fresh context) and `backtest-runner`.
- No session acts on a broker account — places, modifies or closes orders, or changes account settings — except `make kill-switch`, which may flatten mirrored positions, and, once mirroring is on, `make resume` and `make unpause`, which together let the engine trade again; read-only broker access is allowed, and `REDEPLOY=1` without `APPLY=1` on `scripts/canonical/metaapi-connection-doctor.ts` is infrastructure: it prompts every time, is never pre-approved, gets a ledger row, and does not run while mirroring is on until an incident runbook exists (decision 0010). No session writes to the live tables except through `make kill-switch`, `make resume` and `make unpause`, each of which prompts every time, is never pre-approved, prints the mirroring state and writes a ledger row (`docs/runbooks/kill-switch.md`, decision 0010); like every host command, they run only when the operator asks. The one other way is a single statement the operator's message in that turn authorises: the session shows the before-values, names the ids explicitly, uses a `returning` clause, states the expected row count, stops on a mismatch, and writes the ledger line itself, a row in `docs/decisions/deploys.md`, not the host's `deploys.log` (decision 0012). Otherwise the VPS is inspected read-only.

## Working with the operator

Decision 0013 holds these rules in full; the operator can only answer what they can see is blocked.

- **Questions** only at the end of a turn, under a line reading exactly **BLOCKED ON YOU**, one per numbered line (`1. ` at the start of the line, further lines indented), each with a recommended answer; while a question is open, every later turn repeats it as its number and first line only, that line word for word.
- **A turn ends** with READY TO MERGE, then BLOCKED ON YOU, each only when it has items, then, when the session's own work is outstanding, a last `Next action:` line naming the next action and who starts it. Work carried on meanwhile is said and started above them; work longer than a few minutes runs in background agents.
- **The queue:** the operator's order stands; the session's own findings go to the end as proposals.
- **Claims** about how a tool behaves say what was run to check them.
- **Merges** happen only on "merge the queue", for PRs listed as review-clean and green, each at its listed head (`gh pr merge <n> --squash --match-head-commit <sha>`); one behind `dev` is first rebased with `gh pr update-branch <n> --rebase`, then merged at the new head once green; one whose rebase conflicts leaves the list until it is resolved.
- **Reviews:** a docs PR with no runnable command gets one, and one more after a Critical or High is fixed; code, tooling, runbooks and plans with host commands get at most three, ending at one with no Critical or High, else the session stops and asks the operator; Mediums and Lows are fixed or go to `docs/DEBT.md`. A later edit, or a rebase that needed a conflict resolved, gets one review of that diff, unless the conflict is confined to `docs/DEBT.md` rows with both sides' rows kept whole, which needs no review and which the PR says so.
- **Being visible:** sessions start with `caffeinate -is claude`; one frozen hook pushes waits and BLOCKED ON YOU turns to the phone (`docs/DEV_SETUP.md` §16). The session does not look into a failed push, and writes a BLOCKED ON YOU section again when the operator says it could not be read.
- **Push files and merges:** no session reads `~/.config/quanttrader/`, and `gh pr merge` prompts (D-42, D-43).
