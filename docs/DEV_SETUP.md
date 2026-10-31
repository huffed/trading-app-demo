# DEV_SETUP — the tooling around the code

One short section per thing that was set up: **what it is, why it exists, the one command to use it.** Kept current in the same PR as the thing it describes. Sections are added as the Phase B PRs land; the command cheat-sheet in §1 is the only part you need day to day.

## 1. Cheat-sheet

| I want to… | Command | Added in |
|---|---|---|
| see every check | `make help` | B3 |
| run everything CI runs | `make check` (lint, workflows, shell, typecheck, env, fence, db-types, tests) | B3 |
| lint / type-check / test | `make lint` · `make typecheck` · `make test` | B3 |
| format what I changed | `make format` (then `make format-check`) | B3 |
| hold a new file to the target rules | `make lint-strict FILES=path/to/new-file.ts` | B3 |
| lint the GitHub workflow files | `make lint-workflows` | B11 |
| replay the golden trade list | `make backtest` (regenerate on purpose: `make backtest-update`) | B10 |
| open a PR | against `dev`, one at a time, squash-merged; dependent work waits, then rebases (§15) | B13 |
| review a change in a fresh context | ask for the `skeptical-reviewer` agent with the diff (§16) | C1 |
| run the checks through Claude | `/parity-check` · `/regime-report` · `/validate` · `/ftmo-rules` (§16) | C1 |
| edit engine, cron or deploy code in a session | `QT_ALLOW_LIVE_EDITS=1 claude`, not before the audit verdict (§16, decision 0004) | C1 |
| check env names + generated DB types | `make env-check` · `make db-types-check` | B6 / B7 |
| see why CI is red | `gh pr checks <n>` then `gh run view <id> --log-failed` | B6 |
| set up the Python sidecar | `make python-env` | B2/B3 |
| rotate the cron secret | `docs/runbooks/rotate-cron-secret.md` (manual, ~5 min; last done 2026-10-29) | B1 |
| harden the VPS | `docs/runbooks/harden-vps-ssh.md` (Phase 1 done 2026-10-29; Hetzner firewall and Phase 2 remain) | B1 |
| see what production runs | `make status` · `make logs LOG=scan N=40` (read-only, over `ssh qt`) | D1 |
| deploy, or roll back | `make deploy` (default `REF=origin/dev`) · `make deploy REF=<previous sha>` — outside market hours only (§17) | D1 |

Stubs that exit 2 with a message until the audit's scripts reach `dev`: `make validate` / `make parity`.

## 2. Secrets — where they live and the rules

- **Local:** `.env.local` at the repo root (gitignored by `.env*`). Never committed, never read by tooling or by Claude Code sessions; only the cron wrappers grep single names out of it.
- **VPS:** `/opt/quanttrader/.env.local` (0600, root). The app loads it at start; a restart is required after any change. Log in as `ops` (`ssh qt`) and use `sudo` for root-owned paths and the service; root SSH login is disabled since 2026-10-29.
- **GitHub Actions:** repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NTFY_TOPIC`, `NTFY_TOKEN` (dead-man workflow only; CI needs none).
- **`.env.example` is the index:** every variable the code reads appears there by name with a one-line purpose, values never. Adding a `process.env.X` read means adding `X` to `.env.example` in the same PR (a CI check for this arrives with the CI PR).
- **Rotation:** `docs/runbooks/rotate-cron-secret.md`. `CRON_SECRET` was rotated on 2026-10-29: the 2026-10-28 inventory had found its value in a local Claude Code allow-rule (deleted the same day; it was never committed: `git log --all -- .claude/settings.local.json` is empty).
- **Public repo = constraint.** Nothing host-identifying (IPs, user names, SSH lines) goes into the repo; use the `qt` SSH alias and a private ops note.

## 3. GitHub secret scanning and push protection (what to click)

The repo is public, so both are free. They catch a committed token at push time (push protection blocks the push) and in history (scanning alerts).

1. Repo → **Settings** → **Code security** (older UI: "Code security and analysis").
2. **Secret scanning** → **Enable**.
3. Under it, **Push protection** → **Enable**.
4. Optional: **Validity checks** → Enable (GitHub checks whether a found token is live).

Same thing from the CLI (you run it; it changes repo settings):

```bash
gh api -X PATCH repos/huffed/trading-app-demo \
  --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api repos/huffed/trading-app-demo --jq '.security_and_analysis'   # verify
```

Local equivalent (so a secret never reaches GitHub in the first place): `gitleaks` in pre-commit and CI — added by the pre-commit and CI PRs.

## 4. Runbooks

`docs/runbooks/` holds operator procedures with exact commands and a verification checklist each. Current: `rotate-cron-secret.md` (last run 2026-10-29), `harden-vps-ssh.md` (Phase 1 executed 2026-10-29; the Hetzner Cloud firewall and the Phase 2 process-user work remain). Phase D adds deploy, kill-switch, backup/restore.

## 5. Environments — Node, pnpm, Python

**What:** `.nvmrc` pins Node `25.9.0` (what the VPS runs under systemd); `package.json` `engines` says `node >=25.0.0 <26` (the major only; `.nvmrc` is the single source of truth for the exact version and CI reads it), `pnpm >=10`; `pnpm-lock.yaml` is committed and installs use `--frozen-lockfile` (local, CI, VPS). The Python research sidecar is pinned by `scripts/python/pyproject.toml` + `uv.lock` (`requires-python >=3.11,<3.14`; `requirements.txt` is exported from the lock for pip users).

**Why:** three different Node versions were in play (local 25.3, VPS 25.9, `@types/node` 20) and the sidecar had loose `>=` pins with no lock, so "works on my machine" was the only guarantee. Node 25 is not an LTS line: it reached end of life on 2026-06-01 and 25.9.0 was its last release, so the VPS runs an unpatched runtime (DEBT D-21, **High**). Phase D moves the VPS and the pin to a supported LTS line (26 or 24), exact pin everywhere, verified by the full test suite and the golden file on the new runtime. Until then the pin is not changed.

**Commands:**

```bash
nvm use                                  # reads .nvmrc
pnpm install --frozen-lockfile           # never `pnpm install` without the flag on the VPS or in CI
uv sync --project scripts/python         # creates scripts/python/.venv (the TS drivers auto-detect it)
make python-lock                         # after editing pyproject.toml: uv lock + requirements.txt export (target lands with the Makefile PR)
```

## 6. One entry point per check — the Makefile

**What:** `Makefile` at the root; `make help` lists every target with a one-line description. Each target exits non-zero on failure, so the same command works in a terminal, in pre-commit and in CI. `make check` is the local equivalent of CI.

**Why:** before this, "run the checks" meant remembering five pnpm scripts, and nothing ran `scripts/` at all. One name per check also lets CLAUDE.md and the hooks refer to checks without repeating their commands.

**Commands:** see the cheat-sheet (§1). The targets wrap `pnpm exec …`; the pnpm scripts in `package.json` still work (`pnpm lint`, `pnpm typecheck`, `pnpm test`). `BASE=origin/dev` is the comparison point for `format`/`format-check`; override with `make format BASE=main`.

## 7. Lint, types, format — the baseline and the target

**What:**
- **Baseline** (`eslint.config.mjs`, `tsconfig.json`): the rules the code passes today. `make lint` fails on any error and on more warnings than `.eslint-warning-budget` (174 at B3, 171 at B12, 166 since B14; the file is the source of truth). The budget is a ratchet: it may only go down, and a PR that lowers it edits the file.
- **Target** (`eslint.config.strict.mjs`): `typescript-eslint` strict + stylistic type-checked rules, `complexity ≤ 10`, 80-line functions, 300-line files, `no-console` (scripts excepted), no `any`, no object-literal casts, explicit module boundary types, no floating promises, no empty catch, ordered acyclic imports. Every **new** file is held to it from its first PR (pre-commit and CI run it on added files); existing files migrate one PR at a time after the audit verdict and never go back. Settings are never loosened.
- **Types:** `make typecheck` runs `tsc --noEmit` over `src/`, `tests/` and `scripts/` **including test files**. It goes green with PR B5 (155 type errors in test files, type-only fixes, assertions unchanged).
- **Format:** Prettier on changed files only (`make format`, pre-commit). The whole-tree format is one dedicated PR after the audit verdict, with its hash in `.git-blame-ignore-revs`. `make format-all-check` shows the current whole-tree state (informational).
- **Shell:** `make lint-shell` = `shellcheck -S error` on the cron wrappers (the baseline; 0 errors today, target `-S warning`, 6 `SC2155` warnings, DEBT.md) and `shellcheck -S warning` on the Claude hooks, the commit-msg hook and the ops scripts (`scripts/ops/*.sh`, `ops/*.sh`) — new code, held to the target.

**Why:** CI has to exist today, so it starts at the level the code passes; new code must not add to the debt, so it starts at the target. The two configs make that split explicit instead of a convention nobody checks.

## 8. `scripts/` — what is checked and what is not

**What:** `scripts/dev/checked-scripts.mjs` is the single list. Everything under `scripts/` is **live-path** and checked like `src/` (ESLint baseline, tsc, Prettier) **except** the research one-offs it names (`robustness-*`, the June stress runs, feature/label experiments, old search drivers), which **ESLint and `make env-check` skip** — tsc still type-checks them and Prettier still formats them when they change. `scripts/archive/` and run caches are never checked. **Rule (operator 2026-10-29):** a script whose output feeds a decision — a baseline, a verdict, a roadmap gate — is live-path by definition and may not be on the list; the nine that were (verdict, baseline-check, data-pin and round-driver scripts) came off it on 2026-10-30 in B14 (DEBT D-20 names them); 33 research scripts remain listed. Adding a script to the list needs a DEBT.md line. `node scripts/dev/checked-scripts.mjs` prints the live-path file list for tools that cannot import it.

**Why:** 46k lines were excluded from every check, including the deploy scripts, the cron wrappers' TypeScript and the verdict/baseline scripts that produced the live rules. Research scripts are excluded by name, not by directory, so moving nothing (renames wait for the audit) still lets the live-path scripts be checked. Each research script has a target date in `docs/DEBT.md` D-20 (2027-01-31) to be brought under the checks or archived; adding a script to the research list needs a DEBT.md line.

## 9. Pre-commit — what runs before every commit

**What:** `.husky/pre-commit` (installed by `pnpm install` through the `prepare` script, which sets `core.hooksPath=.husky`). On every `git commit` it runs, in order:

1. **gitleaks** on the staged changes (`gitleaks git --pre-commit --staged`) — a secret-shaped string stops the commit. The hook refuses to run at all if gitleaks is missing (`brew install gitleaks`); it never silently skips.
2. **lint-staged** (`.lintstagedrc.mjs`): Prettier writes every staged code file; ESLint baseline runs on staged TS/JS (errors fail); the **target** config runs on files that are new in the commit; shellcheck runs on staged cron wrappers (baseline) and on staged ops scripts and hooks (target); actionlint runs when a file under `.github/workflows/` is staged (`brew install actionlint`; the commit is refused if it is missing, same as gitleaks); shellcheck also covers `.claude/hooks/*.sh` and `.husky/commit-msg`.
3. **commit-msg** (`.husky/commit-msg`): rejects a message containing `Co-Authored-By` or "Generated with" (operator decision 2026-10-29). The committed `.claude/settings.json` also sets `attribution.commit` and `attribution.pr` to empty strings so Claude Code never adds them; the hook catches anything else. `git commit --no-verify` (and `-n`) would bypass every git hook; the committed permissions deny it and `guard-bash` refuses it in any position, and CI fails a PR whose commit messages carry an attribution line.

**Why:** the brief's rule is "a change that alters trades cannot merge unless the golden file is updated on purpose, and nothing fails silently". Pre-commit is the fast local half of that: it catches formatting, lint errors and secrets in seconds, before CI spends minutes. Holding new files to the target config from their first commit is how strictness ratchets up without a big-bang rewrite.

**Commands:**

```bash
pnpm install                 # installs the hook (prepare → husky)
git commit                   # the hook runs; fix what it reports and commit again
git commit --no-verify       # one-off bypass; say why in the PR description
make secrets-scan            # gitleaks over the working tree + staged changes, on demand
make secrets-scan-history    # gitleaks over the full history (~12 min: it re-reads every blob)
```

**What the baseline history scan found (2026-10-28):** no credential has ever been committed. gitleaks' `generic-api-key` rule fires on the string `key` next to long tokens: 375 hits are sha-256 digests and cluster labels inside research artifacts (`scripts/canonical/e2-results/*.json`, `scripts/archive/`), now allowlisted by path in `.gitleaks.toml`; the rest were the flag name `live_trading_enabled=TRUE` in a `ROADMAP.md` lineage row, the empty `NEXT_PUBLIC_SUPABASE_ANON_KEY=` line in an old `CLAUDE.md`, and three `key: "G6_…"` cluster labels in archived research scripts. None is a secret; all are allowlisted by regex in `.gitleaks.toml` so the history scan reports 0. The working-tree scan additionally flags `.env.local` (real secrets, gitignored) and `.next/` build manifests; both are excluded from the `dir` scan by the config so the signal stays clean.

## 10. Database types — generated, and checked against the migrations

**What:** `src/lib/supabase/database.types.ts` is generated from the live Supabase project (`make db-types`, Supabase CLI via `pnpm dlx`, needs `SUPABASE_ACCESS_TOKEN` exported for that shell — a personal token from the Supabase dashboard, never stored in the repo or `.env.local`). `supabase/types.manifest.json` records a sha-256 over `supabase/migrations/*.sql` at generation time; `make db-types-check` (CI) fails when a migration was added or edited after the types were generated.

**Why:** migrations are applied by hand (Supabase MCP or SQL editor) and the types file had drifted nine migrations behind; the 2026-10-28 regeneration showed the only type-level gap was the `last_alpha_decay_tick` RPC. The check cannot see whether the live database has every migration applied — that stays a manual step — but it guarantees the TypeScript view is never older than the migrations folder. Contract defects that live inside `string` columns (the `exit_reason`/`event_type` CHECK lists, DEBT D-01) are invisible to generated types; they need the contract test (PR B9).

**Commands:**

```bash
export SUPABASE_ACCESS_TOKEN=...   # this shell only
make db-types                      # regenerate + stamp; commit both files
make db-types-check                # what CI runs
```

Adding a migration = apply it to the project, `make db-types`, commit the migration, the types and the manifest together.

## 11. CI — what it is and how to read a failed run

**What:** `.github/workflows/ci.yml` runs on every push and pull request, on GitHub's machines, with a fresh clone. Three jobs:

| Job | Runs | Fails when |
|---|---|---|
| `lint · typecheck · test · build` | `make install`, `make lint`, `make lint-workflows`, `make lint-shell`, `make typecheck`, `make env-check`, `make db-types-check`, `make test`, `make build` | any ESLint error or more warnings than the budget; a workflow file GitHub could not parse, a bad expression or a shellcheck error in a `run:` step; any TypeScript error (tests included); a `process.env` name missing from `.env.example`; migrations newer than the generated types; any failing test; a broken production build |
| `target rules on files added in this PR` (PRs only) | `make lint-strict` on files added vs the base branch; `make format-check` on changed files | a **new** file breaks the target rule set; a changed file is not prettier-formatted |
| `gitleaks` | the gitleaks action over the pushed history | a secret-shaped string was committed |

Every job is a Makefile target, so a red job reproduces locally with the same command. The stale one-shot `ftmo-gate-reminder.yml` (a 2026-07-11 reminder that told itself to be deleted) is removed; `dead-man.yml` (production monitoring) is untouched.

**Why:** until now nothing ran tests, lint or build on a push; 109 direct commits landed on `dev` since June with no machine check. CI is the "checked by a machine" half of the mission; branch protection (§12) is what makes it binding.

**Reading a failed run:**
1. The PR page shows a red ✗ next to the job name; click **Details** (or `gh pr checks <number>`; `gh run view --log-failed` prints only the failing step's log).
2. The failing **step** is the Makefile target. Its last lines are the tool's own message: ESLint prints `file:line  error  rule-name`; `tsc` prints `file(line,col): error TS…`; vitest prints the failing test name and the `expected / received` diff; `env-check` and `db-types-check` print exactly what to add or run.
3. Run the same target locally (`make lint`, `make typecheck`, …), fix, push. The run re-triggers.
4. A red `gitleaks` job means a secret reached a commit: rotate it (do not just delete the line — history keeps it), then rewrite the branch.
5. A run that fails within seconds with **no jobs and no log** (`gh run view <id>` says "likely failed because of a workflow file issue") means GitHub could not parse the workflow file itself. `make lint-workflows` (actionlint; also in pre-commit for `.github/workflows/*`) reproduces it locally. It happened on 2026-10-28: a botched edit left shell text on line 1 of `ci.yml`, four runs failed with no output, and nothing local had checked the file.

**Commands:**

```bash
make check                              # the same gates, locally, before pushing
gh pr checks <number>                   # job status for a PR
gh run list --workflow=ci.yml --limit 5 # recent runs
gh run view <run-id> --log-failed       # only the failing step's output
make lint-workflows                     # actionlint over .github/workflows (brew install actionlint)
```

## 12. Branch protection on `dev` — what to click

CI only matters if nothing can merge around it. Protect `dev` (the branch the VPS deploys; `main` is sorted out in Phase D). Created on 2026-10-30 with the CLI command at the end of this section, after the operator authorised it (ruleset id 26211551, enforcement active; the required checks are the three CI job names exactly as the first `dev` run reported them). The clicks below are the equivalent for a fresh repository.

1. Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. Name `protect-dev`; **Enforcement status: Active**; **Target branches** → Add target → *Include by pattern* → `dev`.
3. Tick **Restrict deletions** and **Block force pushes**.
4. Tick **Require a pull request before merging**; required approvals **0** (single operator — the "fresh context" review is the Phase C `skeptical-reviewer` agent plus CI, not a second human); tick **Dismiss stale pull request approvals** and **Require conversation resolution before merging**.
5. Tick **Require status checks to pass**; tick **Require branches to be up to date before merging**; add the checks by name once the first CI run has reported them: `lint · typecheck · test · build`, `target rules on files added in this PR`, `gitleaks`.
6. Tick **Require linear history** (squash or rebase merges only — this is what makes stacked PRs clean).
7. Leave **Bypass list** empty. If you ever need to push directly, you edit the ruleset, which leaves an audit trail.
8. **Create**.

Verify: `gh api repos/huffed/trading-app-demo/rulesets --jq '.[].name'` lists `protect-dev`; a direct `git push origin dev` is now rejected with "Changes must be made through a pull request".

Same thing via the CLI (one call, same effect; the required check names must match the job names above):

```bash
gh api -X POST repos/huffed/trading-app-demo/rulesets --input - <<'JSON'
{ "name": "protect-dev", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/dev"], "exclude": [] } },
  "rules": [
    { "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": true,
      "required_status_checks": [ { "context": "lint · typecheck · test · build" }, { "context": "target rules on files added in this PR" }, { "context": "gitleaks" } ] } }
  ] }
JSON
```

## 13. Tests — layout, characterisation tests, contract tests, and `it.fails`

**What:** three kinds of tests, one runner (`make test` = Vitest):

| Kind | Where | Purpose |
|---|---|---|
| Unit | `src/**/<module>.test.ts`, beside the module | the module's own behaviour, mocks at its edges |
| Characterisation | `tests/characterisation/*.test.ts` | pin what the engine does **today** across modules where the money is — sizing with and without the lot floor, fill simulation, the daily-bias alignment flag, the day-reset timezone, halt flattening — so a change to any of them fails loudly before it ships |
| Contract | `tests/contracts/*.test.ts` | the code's literals vs the database CHECK lists parsed from `supabase/migrations/`, and (next PR) the golden trade list |

A test that exposes a **known defect** is written for the intended behaviour and marked `it.fails(...)` with the audit finding or DEBT id in its name. Vitest counts it as "expected fail". When the defect is fixed, the test starts passing and Vitest reports "expected to fail but passed" — the marker must then come off in the same PR. Today: 11 such cases (the three rejected exit reasons and four rejected event types from audit A4 / draft PR #291, the dropped `higherTfCloseStamped` flag from audit A6, the IEEE-754 lot-floor case from DEBT D-08, and the FTMO day boundary from DEBT D-14).

**Why:** the Phase A audit found no test that spans live and backtest, no test for sizing or fills, and a DB contract that the code violates in three places. Characterisation tests are what make the Phase E refactors safe: they describe current behaviour, including the wrong parts, so a refactor that changes behaviour by accident cannot pass.

**Commands:**

```bash
make test                                   # everything
pnpm exec vitest run tests                  # characterisation + contract tests only
pnpm exec vitest run tests/contracts        # just the DB contract
```

## 14. The golden file — a change that alters trades cannot merge unnoticed

**What:** `tests/golden/xau-usd-h4-2026h1.golden.json` is the full trade list the backtest engine produces for the **five deployed algorithms** (rules snapshot in `tests/golden/deployed-rules-2026-10-28.json`, taken read-only from the `algorithms` table) on the **pinned** XAU/USD 4h and daily corpora, window 2026-01-01 → 2026-07-09 (the audit's locked window starts 2026-07-10), run twice: at the paper capital ($100K) and at the baseline harness's $10K pool where the 0.01-lot floor bites. Per trade: algorithm, entry/exit timestamps, prices, side, P&L, `r_nominal` (P&L over equity-at-entry × risk %, the baseline's statistic), exit reason, MAE, equity at entry. `make backtest` replays and compares (exit 1 on any difference); the vitest test `tests/golden/golden-trades.test.ts` does the same inside `make test`, so CI catches it too.

On 2026-10-28 the two runs are 39 trades / +$7,264 at $100K and 17 trades / +$179 at $10K — the lot floor drops more than half the signals at the small pool, which is the audit's A2 finding, now pinned as a number that cannot drift silently.

**Why:** this is the brief's hard rule — "a change that alters trades cannot merge unless the golden file is updated on purpose". It also freezes the engine's behaviour while the audit's verdict is pending and gives Phase E a before/after artefact for every refactor.

**Commands:**

```bash
make backtest                 # replay + compare; prints trade counts and P&L per run
make backtest-update          # regenerate on purpose; commit the file and say why in the PR
pnpm exec vitest run tests/golden
```

**Rules:** never edit the golden file by hand. A PR that regenerates it must say which trades changed and why (`make backtest` prints the added/missing entries). The pinned data files are never modified (pin policy: a new pin is a new file with its own sha-256); the engine reads them through `scripts/canonical/lib/pinned-eval.ts`, which re-hashes them on every load. Known shape quirks are recorded, not fixed: `exit_date` is a day key because the engine stores exits by day (CODE_QUALITY §3.2), and warm-up trades from 2025-10-01 compound into the equity the window starts with (their count is in the file).

## 15. One PR at a time against `dev` — no stacks

**What:** every PR targets `dev` directly. Work that depends on an open PR waits for that PR to merge, then rebases onto `dev` and opens its own PR. Never stack PRs more than one deep (a PR whose base is another PR's branch). Merges are squash merges; the `protect-dev` ruleset requires linear history.

**Why:** squash-merging the bottom of a stack creates a commit the next branch does not descend from. Git then sees the same files added on both sides and reports add/add conflicts in every following PR. That is exactly what happened at #293 on 2026-10-29 after #292 merged: the remaining twelve branches had to be rebuilt one by one as single commits on `dev` with `--force-with-lease` and merged in turn. One PR at a time costs nothing and cannot produce that state. Independent PRs in parallel are fine.

**Commands:**

```bash
git checkout dev && git pull
git checkout -b tooling/my-change          # one concern per branch
# ... commit, push, open the PR against dev, CI green, squash-merge
git checkout dev && git pull               # start the dependent change from here
git rebase dev my-dependent-branch         # if it was started early, rebase before opening its PR
```

Decision log: `docs/decisions/0002-one-pr-at-a-time.md`.

## 16. Claude Code in this repository — what is committed and what it does

**What:** `.claude/` is committed except `settings.local.json` (personal; it once held `CRON_SECRET`) and `worktrees/`. Four pieces, all under `.claude/`:

| Piece | Where | What it does |
|---|---|---|
| Shared settings | `settings.json` | `attribution.commit` and `attribution.pr` are empty strings, so Claude Code adds no `Co-Authored-By` trailer or "Generated with" footer (the `commit-msg` hook in §9 is the backstop). `permissions.allow` pre-approves the **read-only or self-checking** commands by exact target: `make lint|lint-shell|lint-workflows|lint-strict|typecheck|test|backtest|check|env-check|fence-check|db-types-check|format-check|regime-report|help`, `pnpm test`, `pnpm exec vitest run`, `pnpm exec tsc --noEmit`, `pnpm exec prettier --check`, `git status|diff|log|show|blame|add|commit`, `gh pr view|diff|checks`, `gh run view|list`. `permissions.ask` prompts for everything that writes outside a commit: `make backtest-update|format|format-all-check|db-types|install|python-env|python-lock`, the golden replay script run directly, `eslint` (it can `--fix`), `prettier --write`, `pnpm install|add|remove`, and edits under `.claude/`, `.husky/` and `.github/workflows/` (the fence protects itself). `permissions.deny` (first match wins over everything, cannot be lifted in a session): read or edit `.env*` except `.env.example`; edit pinned data (`scripts/canonical/data/**`) or any JSON under `tests/golden/`; `git commit --no-verify` / `-n`; plain `git push --force` / `-f`. Path rules use `Edit(...)`, which covers every editing tool; the docs say `Read` denies also cover `cat`/`sed`/`tee` in Bash, and that is best-effort for subprocesses (DEBT D-22). |
| Hooks | `hooks/*.sh`, `hooks/lib/hook-input.cjs`, `hooks/live-paths.txt` | All hooks parse the tool payload through one node helper and **fail closed**: malformed input, a missing `node` or an internal error refuses the call. Paths are resolved to the real project root (symlinks, `..`, `.claude/worktrees/<x>/` copies, upper/lower case on macOS) before matching. **guard-paths** (before Edit/Write/MultiEdit/NotebookEdit): refuses `.env*` (not `.env.example`), pinned data, every JSON under `tests/golden/`, and the live-runner paths in `live-paths.txt` (the scan engine, the broker adapters, every API route, the cron wrappers, the scripts they run, the deploy scripts, the baseline harness library, and since D1 `ops/**` and `scripts/ops/**`). `QT_ALLOW_LIVE_EDITS=1` in the session lifts only the live-runner part, for the PR that is about the engine (`docs/decisions/0004`); while it is set, every live-path edit leaves a one-line `FENCE DOWN` notice in the transcript. The variable is never set in a committed file or a shell profile (`make fence-check`, part of `make check` and CI, fails if it or `QT_STOP_VALIDATE` is assigned in one), and no session sets it before the audit verdict. **guard-bash** (before Bash): splits the command into simple commands (the inside of `$(…)` included), strips wrappers from each head (`sudo`, `env`, `xargs`, `nice`, `time`, `VAR=value` prefixes, `/bin/` paths, a leading backslash, shell keywords) and refuses: reads or writes of `.env*` through readers, interpreters, `--env-file`, redirects and pipelines that feed a reader, quoted or not, any case; writes into pinned data or golden inputs including `rm`/`mv`/`git rm`/`git checkout`/`find -delete`/redirects and destructive verbs on their parent directories; shell writes into the live paths (same list, same override, same notice); mirror pushes, and force, delete or `+ref` pushes touching `dev`/`main`, including a bare `git push --force` while one of them is checked out; `git commit --no-verify` (any prefix), `-n`, `HUSKY=0`; and pre-approved commands turned into writes (`make -f`/`-C`/`--eval` or a variable override with shell metacharacters, `git … --output`/`-O`, `vitest -u`/`--outputFile`, `prettier --check --write`). Pattern-based and best-effort by nature (DEBT D-22). **reviewer-bash-allowlist** (registered only in the `skeptical-reviewer` agent's frontmatter): an exact-match allow-list of read-only commands (quoted path tokens allowed, so `src/app/(dashboard)/…` files can be named); command and process substitution, heredocs, input redirection, output redirects other than `/dev/null` and `>&1`/`>&2`, make variables, recursive `grep`, and flags that write, run a module or change configuration (`--fix`, `--write`, `-u`, `--output`, `-O`, `--config` other than the repo's two ESLint configs, `--plugin`, `--format`, `--setupFiles`) are refused. **post-edit-lint** (after Edit/Write): Prettier check plus ESLint on the edited code file — the target config for a file that is new in the working tree, the baseline config at errors only for an existing file (never the warning budget, so inherited warnings in audit-cited files are not pushed into line-moving "fixes"); problems are shown to Claude at once. **stop-validate** (when Claude stops): **off by default**; `QT_STOP_VALIDATE=1` makes it run `make validate` and refuse to stop on a red result (today the target is a stub, so leave it off until the harness lands). Hooks block with exit 2 and the reason on stderr; `tests/hooks/hooks.test.ts` pins every rule above with real payloads and runs in `make test`. |
| Agents | `agents/skeptical-reviewer.md`, `agents/backtest-runner.md` | `skeptical-reviewer` (Opus; Read, Grep, Glob, and a Bash limited by the allowlist hook to exact read-only forms of `git diff|log|show|blame|status`, `gh pr diff|view|checks`, `make lint|typecheck|test|backtest|regime-report`, `pnpm exec vitest run`, `tsc --noEmit`, `prettier --check` and a few viewers, so it verifies claims without being able to write) is the "reviewed in a fresh context" half of the mission: it assumes the change is wrong and reports file:line findings. Its first run reviewed PR #307 itself and found the fixes recorded in that PR. `backtest-runner` (Sonnet; Bash) runs `make backtest`, `make regime-report`, `make validate`, `make parity` and reports verbatim; it never regenerates the golden file. |
| Skills | `skills/validate`, `skills/parity-check`, `skills/regime-report`, `skills/ftmo-rules` | `/validate` and `/parity-check` run the Makefile targets (both stubs until the audit's scripts reach `dev`) and explain what the output means; `/regime-report [h4-bars] [days]` runs the pinned-data regime report; `/ftmo-rules` is the FTMO 2-Step Swing rule set and the repo's R conventions. Each command skill pre-approves only its own `make` target. |

Also from Phase C: `.husky/commit-msg` rejects attribution lines (§9); `CLAUDE.md` is short (44 lines) and the long-form notes it used to hold are `docs/PROJECT_CONTEXT.md`.

**Why:** the brief's "Claude-shaped repo": a fresh session finds where behaviour lives from `CLAUDE.md` and the tree, cannot touch secrets or live paths by accident, gets lint feedback at edit time rather than at commit time, and has a reviewer that did not write the change. The deny list is the hard stop; the hooks are the explained stop; the ratchet, the golden file and CI remain the merge gate. Claude Code has no per-hook switch, so `QT_STOP_VALIDATE` is our own guard inside the script; `"disableAllHooks": true` in `settings.local.json` turns every hook off for one machine.

**Commands:**

```bash
QT_ALLOW_LIVE_EDITS=1 claude          # a session whose PR is about the engine / crons / deploy
QT_STOP_VALIDATE=1 claude             # make the Stop hook run `make validate` (off by default)
printf '%s' '{"tool_input":{"file_path":"'"$PWD"'/src/lib/scan/x.ts"}}' | .claude/hooks/guard-paths.sh; echo $?   # 2 = blocked
claude doctor                         # lists settings entries Claude Code rejected
```

**Rules:** a new hook, agent or skill is a PR with a row in this table. Hooks exit 2 to block or to feed output back, 0 to allow; never make one exit non-zero silently. Anything a skill or agent runs must be read-only against the database and the broker; the `scripts/canonical/` verdict scripts run only through Makefile targets. `git commit --no-verify` bypasses every git hook and is not used in this repository. `make lint-shell` covers the hook scripts and the commit-msg hook.

## 17. Deploying to the VPS — one command, verified, reversible

**What:** `make deploy [REF=…]` deploys a commit (default `origin/dev`) to `quanttrader-prod` and `make deploy REF=<previous sha>` is the rollback — the same path, no special case. The workstation side (`scripts/ops/deploy-driver.sh`) copies `scripts/ops/deploy.sh` to the host and runs it as root (`sudo -n -H`; D.2 makes it `ops`). On the host the script: refuses a dirty tree; fetches; checks out the exact commit detached; requires the host's Node to equal the commit's `.nvmrc` (a commit without one logs and passes); `pnpm install --frozen-lockfile`; `pnpm build`; waits for the gap between cron ticks (manage and heartbeat fire every 5 minutes, scan every 15) and restarts the service; requires `/login` → 200 within 90 s and the heartbeat route → 200 with the host's `CRON_SECRET` (read on the host, never printed); then waits for the next scheduled manage and heartbeat ticks and requires both to log `http=200`; appends `OK`/`FAIL` to `/var/log/quanttrader/deploys.log`; prints `DEPLOYED_SHA=` and `PREVIOUS_SHA=`. Only then does the driver move the production pointer `main` to the deployed commit (fast-forward; a rollback to an ancestor is a leased force-update; a divergent commit leaves `main` alone and says so) and append a row to `docs/decisions/deploys.md`, which you commit in your next PR. `make status` (read-only) shows service state, deployed commit, last line per cron log, pending reboot, disk, crontab sizes and `origin/dev` for comparison; `make logs LOG=<name> N=<lines>` tails a cron log. `ops/` holds the host's unit, crontab, sshd drop-in and firewall as code (`ops/README.md` says how each is applied).

**Why:** before D.1 the host was deployed by hand as root with no record and no check that the service came back, `node_modules` on the host dated from two months before the checkout, and `main` did not exist on the remote. The audit needs deploy dates to bracket paper results, and the operator required the rollback to be one written-down command before the first deploy (decision 0005).

**Commands:**

```bash
make status                                  # what is running, last ticks, pending reboot
make deploy                                  # origin/dev → VPS, verified, then main moves
make deploy REF=3ee22e2                      # rollback to the commit that ran 2026-10-19 → 2026-10-31
make logs LOG=deploys N=10                   # the host's own deploy ledger
make logs LOG=manage N=5                     # did the last manage tick answer 200?
ssh qt 'sudo -n reboot'; sleep 60; make status   # a reboot: ledger row + decision entry, outside market hours
```

**Rules:** no VPS change during market hours (Sunday 22:00 to Friday 22:00 UK) except the kill switch (D.3). Every deploy leaves its ledger row; every other host change (reboot, package, config) gets a ledger row and, when it changes behaviour, a `docs/decisions/` entry. `main` is never pushed by hand. A change to anything under `ops/` or `scripts/ops/` is a PR about the host; those are live-runner paths for the hooks (§16). A deploy script failure is final: read the step it names, fix the cause, run again; never restart the service by hand to "finish" a failed deploy.
