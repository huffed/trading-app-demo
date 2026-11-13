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
| open a PR | against `dev`, one concern each, squash-merged; independent PRs may be open together, dependent work waits, then rebases (§15) | B13 |
| start a Claude session | `caffeinate -is claude` (no idle or system sleep on AC power, per `pmset -g assertions`; §16) | 11-13 |
| know when a session is waiting on me | ntfy pushes for prompts, idle waits and BLOCKED ON YOU; set the topic once (§16) | 11-13 |
| review a change in a fresh context | ask for the `skeptical-reviewer` agent with the diff (§16) | C1 |
| run the checks through Claude | `/parity-check` · `/regime-report` · `/validate` · `/ftmo-rules` (§16) | C1 |
| edit engine, cron or deploy code in a session | `QT_ALLOW_LIVE_EDITS=1 claude`, not before the audit verdict (§16, decision 0004) | C1 |
| check env names + generated DB types | `make env-check` · `make db-types-check` | B6 / B7 |
| see why CI is red | `gh pr checks <n>` then `gh run view <id> --log-failed` | B6 |
| set up the Python sidecar | `make python-env` | B2/B3 |
| rotate the cron secret | `docs/runbooks/rotate-cron-secret.md` (manual, ~5 min; last done 2026-10-29) | B1 |
| harden the VPS | `docs/runbooks/harden-vps-ssh.md` (Phase 1 done 2026-10-29; Phase 2 process user done 2026-11-01 as D.2, `d2-node-26-ops-user-loopback.md`, decision 0007; Hetzner firewall and sudoers narrowing remain, D.7) | B1 / D2 |
| see what production runs | `make status` · `make logs LOG=scan N=40` (read-only, over `ssh qt`) | D1 |
| deploy, or roll back | `make deploy` (default `REF=origin/dev`) · `make deploy REF=<previous sha>` — outside market hours only (§17) | D1 |
| stop all trading now | `make kill-switch REASON=<word>` — the one host command allowed in market hours (the one other exception: appending the `HEARTBEAT_PING_URL` line, §17); then `make resume`, then `make unpause` when trading should restart (§18) | D3 |
| know when the host is unwell | ntfy pushes from the host: unit failure, deploy result, daily 07:05 UTC summary; `make logs LOG=ops-health N=2` (§19) | D4 |
| back up, or test a restore | nightly at 02:22 UTC from the `ops` crontab; `make logs LOG=backup N=20`, runbook `docs/runbooks/d6-backups.md` (§20) | D6 |
| catch drift nobody touched | the nightly workflow runs `make check` + `make backtest` on `dev` (scheduled 03:17 UTC, started around 10:45 UTC so far) and pushes on failure (§19) | D5 |

Stubs that exit 2 with a message until the audit's scripts reach `dev`: `make validate` / `make parity`.

## 2. Secrets — where they live and the rules

- **Local:** `.env.local` at the repo root (gitignored by `.env*`). Never committed, never read by tooling or by Claude Code sessions; only the cron wrappers grep single names out of it.
- **VPS:** `/opt/quanttrader/.env.local` (0600, root). The app loads it at start; a restart is required after any change. Log in as `ops` (`ssh qt`) and use `sudo` for root-owned paths and the service; root SSH login is disabled since 2026-10-29.
- **GitHub Actions:** repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NTFY_TOPIC`, `NTFY_TOKEN` (dead-man workflow only; CI needs none).
- **`.env.example` is the index:** every variable the code reads appears there by name with a one-line purpose, values never. Adding a `process.env.X` read means adding `X` to `.env.example` in the same PR (a CI check for this arrives with the CI PR).
- **Rotation:** `docs/runbooks/rotate-cron-secret.md`. `CRON_SECRET` was rotated on 2026-10-29: the 2026-10-28 inventory had found its value in a local Claude Code allow-rule (deleted the same day; it was never committed: `git log --all -- .claude/settings.local.json` is empty).
- **Public repo = constraint.** Nothing host-identifying (IPs, user names, SSH lines) goes into the repo; use the `qt` SSH alias and a private ops note. One recorded exception: the Storage Box name and sub-account, on the operator's instruction (decision 0011).

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

**What:** `.nvmrc` pins Node `26.13.0` (the "Lithium" LTS line, what the VPS runs system-wide at `/usr/local` from D.2 on, decision 0007); `package.json` `engines` says `node >=26.0.0 <27` (the major only; `.nvmrc` is the single source of truth for the exact version, CI reads it, and `make deploy` refuses a host or a unit whose Node differs from it), `pnpm >=10`; `pnpm-lock.yaml` is committed and every install uses `--frozen-lockfile`. Python: `scripts/python/pyproject.toml` + `uv.lock` + an exported `requirements.txt` for the sidecar.

**Why:** three different Node versions were in play (local 25.3, VPS 25.9, `@types/node` 20) and the sidecar had loose `>=` pins with no lock, so "works on my machine" was the only guarantee. Node 25 was not an LTS line and reached end of life on 2026-06-01 (DEBT D-21); the move to 26 is D.2 (decision 0007), made after the full suite, the golden file and the production build were clean on 26.13.0 locally (dev @ 396d710 on 2026-10-31: 2176 passed + 11 expected failures; this PR's commit: 2216 + 11).

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
# ... commit, push, open the PR against dev, CI green, review clean, squash-merge (a session waits for "merge the queue", CLAUDE.md)
git checkout dev && git pull               # start the dependent change from here
git rebase dev my-dependent-branch         # if it was started early, rebase before opening its PR
```

Decision log: `docs/decisions/0002-one-pr-at-a-time.md`.

## 16. Claude Code in this repository — what is committed and what it does

**What:** `.claude/` is committed except `settings.local.json` (personal; it once held `CRON_SECRET`) and `worktrees/`. Five pieces, all under `.claude/`:

| Piece | Where | What it does |
|---|---|---|
| Shared settings | `settings.json` | `attribution.commit` and `attribution.pr` are empty strings, so Claude Code adds no `Co-Authored-By` trailer or "Generated with" footer (the `commit-msg` hook in §9 is the backstop). `permissions.allow` pre-approves the **read-only or self-checking** commands by exact target, never with arguments — `make lint\|lint-shell\|lint-workflows\|lint-strict\|typecheck\|test\|backtest\|check\|env-check\|fence-check\|db-types-check\|format-check\|regime-report\|help` (`lint-strict` lints the files added vs `BASE` by default, `format-check` and `regime-report` have defaults; a form with arguments prompts, because a wildcard make rule can carry a host goal or an `--eval` into a pre-approved command, §18; a leading `VAR=value` does not bypass an exact rule — a default-mode session prompted on `FOO=1 make help`, operator test 2026-11-02; the workstation had Claude Code 2.1.308 installed, the test session's version was not recorded; re-run after a Claude Code upgrade, in a default-mode session: `make help` must run without a prompt as the control, then `FOO=1 make help`, `PNPM=true make lint-strict` and `FOO=1 git status` (a wildcard rule) must all prompt) — `pnpm test`, `pnpm exec vitest run`, `pnpm exec tsc --noEmit`, `pnpm exec prettier --check`, `git status\|diff\|log\|show\|blame\|add\|commit`, `gh pr view\|diff\|checks`, `gh run view\|list`. `permissions.ask` prompts for everything that writes outside a commit: `make backtest-update\|format\|format-all-check\|db-types\|install\|python-env\|python-lock`, the golden replay script run directly, `eslint` (it can `--fix`), `prettier --write`, `pnpm install\|add\|remove`, every command naming `scripts/canonical/metaapi-connection-doctor.ts` (decision 0010; after a Claude Code upgrade, `git show HEAD:` of it must prompt), the VPS targets `make deploy\|deploy-pointer\|status\|logs\|kill-switch\|resume\|unpause` in both spellings and every flagged `make -…` (every command that reaches the host is the operator's call; `tests/ops/makefile-host-targets.test.ts` fails if an allow rule could pre-approve one), raw `ssh\|scp\|sftp\|rsync *` (§17; `tests/ops/raw-host-commands.test.ts`), every command naming `scripts/ops/deploy-driver.sh` (it reaches the host itself) or `scripts/canonical/enable-broker-mirror.ts` (it turns mirroring on, D-33), and edits under `.claude/`, `.husky/` and `.github/workflows/` (the fence protects itself). `permissions.deny` (first match wins over everything, cannot be lifted in a session): read or edit `.env*` except `.env.example`; edit pinned data (`scripts/canonical/data/**`) or any JSON under `tests/golden/`; `git commit --no-verify` / `-n`; plain `git push --force` / `-f`. Path rules use `Edit(...)`, which covers every editing tool; the docs say `Read` denies also cover `cat`/`sed`/`tee` in Bash, and that is best-effort for subprocesses (DEBT D-22). |
| Hooks | `hooks/*.sh`, `hooks/lib/hook-input.cjs`, `hooks/live-paths.txt` | All the hooks in this row parse the tool payload through one node helper and **fail closed**: malformed input, a missing `node` or an internal error refuses the call. Paths are resolved to the real project root (symlinks, `..`, `.claude/worktrees/<x>/` copies, upper/lower case on macOS) before matching. **guard-paths** (before Edit/Write/MultiEdit/NotebookEdit): refuses `.env*` (not `.env.example`), pinned data, every JSON under `tests/golden/`, and the fenced live paths in `live-paths.txt` — the trading code: engine and runner, strategies, risk and sizing, execution, the engine's migrations, the paper engine's price config, the cron wrappers and the scripts they run, the baseline harness library; the exact list is `docs/decisions/0006`. Infrastructure (`ops/**`, `scripts/ops/**`) is not fenced. `QT_ALLOW_LIVE_EDITS=1` in the session lifts only the live-runner part, for the PR that is about the engine (`docs/decisions/0004`); while it is set, every live-path edit leaves a one-line `FENCE DOWN` notice in the transcript. The variable is never set in a committed file or a shell profile (`make fence-check`, part of `make check` and CI, fails if it or `QT_STOP_VALIDATE` is assigned in one), and no session sets it before the audit verdict. **guard-bash** (before Bash): splits the command into simple commands (the inside of `$(…)` included), strips wrappers from each head (`sudo`, `env`, `xargs`, `nice`, `time`, `VAR=value` prefixes, `/bin/` paths, a leading backslash, shell keywords) and refuses: reads or writes of `.env*` through readers, interpreters, `--env-file`, redirects and pipelines that feed a reader, quoted or not, any case; writes into pinned data or golden inputs including `rm`/`mv`/`git rm`/`git checkout`/`find -delete`/redirects and destructive verbs on their parent directories; shell writes into the live paths (same list, same override, same notice); mirror pushes, and force, delete or `+ref` pushes touching `dev`/`main`, including a bare `git push --force` while one of them is checked out; `git commit --no-verify` (any prefix), `-n`, `HUSKY=0`; and pre-approved commands turned into writes (`make -f`/`-C`/`--eval`/`MAKEFILES=`/a makefile on stdin, quoted or not, a host target beside another goal, behind a flag or behind an override, or a variable override with shell metacharacters; `git … --output`/`-O`; `vitest -u`/`--outputFile`; `prettier --check --write`; and a pre-approved `prettier --check`, `vitest` or `tsc --noEmit` given any flag off its short list, behind a `VAR=` prefix or a wrapper, or continued over lines. Each tool has flags that import a file, run a program or write one, such as prettier `--config`, `--plugin`, `--config-path`, `--cache-location`, vitest `--reporter ./x`, `--environment`, `--execArgv`, `--outputFile.json` and `-vc`, and tsc `--generateTrace`, so only flags known to do none of that are allowed. prettier: `--check`/`-c`, `-l`, `--log-level`, `--ignore-unknown`, `--no-error-on-unmatched-pattern`, `--no-editorconfig`, colour. vitest: `-t`, `--bail`, `--retry`, the timeouts, `--maxWorkers`, a built-in `--reporter` name, `--silent`, `--passWithNoTests`, colour. tsc: `-p tsconfig*.json`, `--pretty`, `--skipLibCheck`, `--listFilesOnly`, `--extendedDiagnostics`, with no `--` (tsc goes on parsing flags after it), no `true`/`false`/`null` word (`--noEmit false` turns emit on) and no `@file`. The words are read quote-aware from the command as written, so `-t "--config x"` is a test name. A `$` or backtick outside single quotes, or a `{` outside any quotes, is refused, because the shell would expand it into words the guard never sees. So is a command with any continuation line, a backslash-newline or a newline inside quotes. tsc's `-p` takes a separate value; tsc has no `--flag=value` form); and, rule 8 (§17), any host command not run bare to the `qt` alias with short-listed options, anything else that names one unless it only reads or prints it, what rsync or git would reach a host with, and shell writes under `~/.ssh`. Rule 6 refuses any command that names `scripts/canonical/enable-broker-mirror.ts` and runs something able to execute it, until `MODERNISATION.md` P19 lands (D-33). The name counts anywhere in the command: any `enable-broker…` name, across continuation lines, quoted or not. When the name is there, any runner word anywhere in a segment counts, quotes removed and case folded: an interpreter, `awk`, a TypeScript or package runner at any path (`node_modules/.bin/tsx`, `vite`, `vitest`, `corepack`), `timeout` or `ssh`. So a runner behind `VAR="a b"`, `xargs -I{}`, `find -exec`, `nice -n` or `sudo -u` is seen, and so is one after a backslash-newline. The exceptions are a command that only reads or prints, and `pnpm\|npx [exec] eslint\|prettier\|tsc` with no flag that loads a module (`-c`, `--config`, `--plugin`, `--require`…; `prettier --config` imports the file it names). Reading the file stays allowed (`cat`, `grep`, `git log`, `eslint`, `prettier`, `tsc`), but not on the host (`ssh qt 'grep …'`), and `Bash(*enable-broker-mirror*)` is an ask rule, so every command naming it prompts. Because any runner word counts once the script is named, text is refused too when it names the script and mentions a runner anywhere: a test filter beside `pnpm`, a heredoc commit body with a line such as "the guard now refuses tsx", or `gh … --body '…'`. Write such text with the file tools and pass it with `git commit -F` or `gh … --body-file`. `pnpm exec eslint --config <file>` on the script is refused as well; lint it with `make lint-strict FILES=…`. Pattern-based and best-effort by nature (DEBT D-22). **reviewer-bash-allowlist** (registered only in the `skeptical-reviewer` agent's frontmatter): an exact-match allow-list of read-only commands (quoted path tokens allowed, so `src/app/(dashboard)/…` files can be named); command and process substitution, heredocs, input redirection, output redirects other than `/dev/null` and `>&1`/`>&2`, make variables, recursive `grep`, and flags that write, run a module or change configuration (`--fix`, `--write`, `-u`, `--output`, `-O`, `--config` other than the repo's two ESLint configs, `--plugin`, `--format`, `--setupFiles`) are refused. **post-edit-lint** (after Edit/Write): Prettier check plus ESLint on the edited code file — the target config for a file that is new in the working tree, the baseline config at errors only for an existing file (never the warning budget, so inherited warnings in audit-cited files are not pushed into line-moving "fixes"); problems are shown to Claude at once. **stop-validate** (when Claude stops): **off by default**; `QT_STOP_VALIDATE=1` makes it run `make validate` and refuse to stop on a red result (today the target is a stub, so leave it off until the harness lands). Hooks block with exit 2 and the reason on stderr; `tests/hooks/hooks.test.ts` pins every rule above with real payloads and runs in `make test`. |
| Notification and Stop push | `hooks/notify-ntfy.sh`; registered on `Notification` (the matcher) and on `Stop` in `settings.json`; tests in `tests/hooks/notify-ntfy.test.ts` and `notify-ntfy-stop.test.ts` | Pushes to the operator's phone through ntfy when a session waits on them (decision 0013). On Notification: "permission needed", "question for you" and "a background session needs you" at high priority, "waiting for you" at default; types `permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog`, and any other type sends nothing. Only the permission prompt sends Claude Code's own message, a generic sentence seen on 2026-11-12; the others send fixed text, because a dialog's text can come from an MCP server. Per the hooks docs (read 2026-11-13), Claude Code sends `permission_prompt` once a prompt has waited about 6 s with no typing, so a prompt answered faster sends nothing; it sends `idle_prompt` about 60 s after a turn ends, never while a background agent still runs. On Stop, at every turn end: only when the turn's last message (`last_assistant_message`) has a line reading BLOCKED ON YOU, outside a code block, with at least one numbered line (`1. `, `**1. `, `1) `) under it before the next heading, READY TO MERGE or Next action line, does it push "questions for you" at high priority, with the number of those lines and never their text, once per set of numbered lines in a session, also while background agents run. The body is the session name and that message; Claude Code's own message is generic ("Claude needs your permission"). The name is the latest `/rename` title, else the latest AI title, in the transcript's last 8 MB, else the folder and the session id. The transcript format is internal to Claude Code, so a release can leave only the fallback. The topic is the first line of `~/.config/quanttrader/ntfy-topic`. A reserved topic also needs the access token, the first line of `~/.config/quanttrader/ntfy-token`; without it ntfy refuses the push. Both files are outside the repo, and no session may read them; no deny rule enforces that yet. curl starts with `-q`, so it reads no `~/.curlrc` (checked 2026-11-13: with a planted `.curlrc` holding `-w '%{url_effective}'`, curl printed the URL without `-q` and nothing with it), and takes the URL and the token from stdin, so neither is in argv, output or the log. Each push it tries is one line in `~/.local/state/quanttrader/notify.log`, with curl's exit code and the HTTP status when it fails; input that is not a Notification or Stop event sends nothing and is logged. Claude Code ignores a Notification hook's exit code and discards its `systemMessage`; on Stop a push that did not go out is also printed as a `systemMessage`. The docs do not say a Stop hook's is shown; on 2026-11-13 at 09:51Z this session's transcript recorded one as a `hook_system_message` from the Stop hook ("Phone push for BLOCKED ON YOU: not sent: no topic in …"). Whether the terminal displayed it was not seen by the session. Unlike the guards, it reads its payload with jq and fails open; it always exits 0. A sleeping Mac sends nothing. Delivery to the phone: pending the operator's test. |
| Agents | `agents/skeptical-reviewer.md`, `agents/backtest-runner.md` | `skeptical-reviewer` (Opus; Read, Grep, Glob, and a Bash limited by the allowlist hook to exact read-only forms of `git diff\|log\|show\|blame\|status`, `gh pr diff\|view\|checks`, `make lint\|typecheck\|test\|backtest\|regime-report`, `pnpm exec vitest run`, `tsc --noEmit`, `prettier --check` and a few viewers, so it verifies claims without being able to write) is the "reviewed in a fresh context" half of the mission: it assumes the change is wrong and reports file:line findings. Its first run reviewed PR #307 itself and found the fixes recorded in that PR. `backtest-runner` (Sonnet; Bash) runs `make backtest`, `make regime-report`, `make validate`, `make parity` and reports verbatim; it never regenerates the golden file. |
| Skills | `skills/validate`, `skills/parity-check`, `skills/regime-report`, `skills/ftmo-rules` | `/validate` and `/parity-check` run the Makefile targets (both stubs until the audit's scripts reach `dev`) and explain what the output means; `/regime-report [h4-bars] [days]` runs the pinned-data regime report; `/ftmo-rules` is the FTMO 2-Step Swing rule set and the repo's R conventions. Each command skill pre-approves only its own `make` target. |

Also from Phase C: `.husky/commit-msg` rejects attribution lines (§9); `CLAUDE.md` is short (62 lines) and the long-form notes it used to hold are `docs/PROJECT_CONTEXT.md`.

**Why:** the brief's "Claude-shaped repo": a fresh session finds where behaviour lives from `CLAUDE.md` and the tree, cannot touch secrets or live paths by accident, gets lint feedback at edit time rather than at commit time, and has a reviewer that did not write the change. The deny list is the hard stop; the hooks are the explained stop; the ratchet, the golden file and CI remain the merge gate. Claude Code has no per-hook switch, so `QT_STOP_VALIDATE` is our own guard inside the script; `"disableAllHooks": true` in `settings.local.json` turns every hook off for one machine.

**Commands:**

```bash
QT_ALLOW_LIVE_EDITS=1 claude          # a session whose PR is about the engine / crons / deploy
QT_STOP_VALIDATE=1 claude             # make the Stop hook run `make validate` (off by default)
printf '%s' '{"tool_input":{"file_path":"'"$PWD"'/src/lib/scan/x.ts"}}' | .claude/hooks/guard-paths.sh; echo $?   # 2 = blocked
claude doctor                         # lists settings entries Claude Code rejected
caffeinate -is claude                 # start every session this way: no idle sleep, and no system sleep on AC power
tail -n 5 ~/.local/state/quanttrader/notify.log   # what the Notification hook did with the last waits
```

Set the ntfy topic, and the access token if the topic is reserved, once. The line below is zsh, macOS's default shell (checked 2026-11-13 against a throwaway `HOME`, the clipboard step left out: both files mode 600, an existing 0644 file included, and an empty token for Enter); run it in a terminal, not through a session's `!`, because it asks for both. Paste each from the password manager; neither is echoed, and Enter alone means no token. The `umask` and the `chmod` keep both files private, also when they already exist. The last step empties the current clipboard even when an earlier step failed; a clipboard manager's history is not cleared.

```zsh
mkdir -p ~/.config/quanttrader && (umask 077 && read -rs 't?ntfy topic: ' && print && read -rs 'k?ntfy access token (Enter if the topic is not reserved): ' && print && print -r -- "$t" > ~/.config/quanttrader/ntfy-topic && print -r -- "$k" > ~/.config/quanttrader/ntfy-token) && chmod 600 ~/.config/quanttrader/ntfy-*; pbcopy < /dev/null
```

What `caffeinate -is` does and does not hold, from `man caffeinate`, `pmset -g assertions` (with it running, both PreventUserIdleSystemSleep and PreventSystemSleep held) and `pmset -g log` on 2026-11-13; a closed lid on AC power was not tested:
- `-i` stops idle sleep, and `-s` stops system sleep, but `-s` holds only on AC power.
- On battery the Mac still sleeps: `pmset -g log` shows 349 sleeps since 6 November, all on battery, while a `caffeinate -dis` was running (the log does not show the lid). The 12.9 h stall of 6–7 November was a "Low Power Sleep" at 1% charge.

**Rules:** a new hook, agent or skill is a PR with a row in this table. Hooks exit 2 to block or to feed output back, 0 to allow; never make one exit non-zero silently. Anything a skill or agent runs must be read-only against the database and the broker; the `scripts/canonical/` verdict scripts run only through Makefile targets. `git commit --no-verify` bypasses every git hook and is not used in this repository. `make lint-shell` covers the hook scripts and the commit-msg hook.

## 17. Deploying to the VPS — one command, verified, reversible

**What:** `make deploy [REF=…]` deploys a commit (default `origin/dev`) to `quanttrader-prod`; `make deploy REF=<previous sha>` is the rollback, the same path with no special case. The workstation side (`scripts/ops/deploy-driver.sh`, running everything on the host as `ops`; `sudo -n systemctl restart quanttrader` is the only privileged step) refuses unless `scripts/ops/` in the checkout equals `origin/dev` (only the reviewed scripts ever run on the host), resolves `REF` to a commit that is on `origin/dev` (names are looked up on origin first, so `REF=dev` means `origin/dev`, and a commit that never reached `dev` is refused), streams the host script **from `origin/dev`** to a per-run file and starts it **detached** with its output in `/var/log/quanttrader/deploy-<stamp>.log`, then follows that log; a dropped connection or a Ctrl-C does not stop the run (`make logs LOG=deploy-<stamp> N=60` shows the run's log so far, `make status` the outcome). Both sides refuse to act in market hours (Sunday 22:00 to Friday 22:00 UK; the driver also refuses in the hour before the Sunday open, and the host re-checks right before the restart) unless `QT_MARKET_HOURS_OK=1` is set on the workstation — the operator's call, recorded as `market_ok=1` in the host's ledger line and as "market-hours override used" in the row here. On the host, `scripts/ops/deploy.sh` takes a lock (one deploy at a time), refuses a dirty tree, fetches, reads the commit's `.nvmrc` from git and requires both the host's Node and the Node the unit's `ExecStart` points at to equal it before anything is touched (a commit without one runs on the host's Node, which the ledger records), checks out the exact commit detached, runs `pnpm install --frozen-lockfile` and `pnpm build`; if either fails it **restores the working tree and the build of the running commit** (`next build` empties `.next` first, so a failed build would otherwise leave a host with no build on disk) and the service is never restarted. It then waits up to 20 minutes for a gap between cron ticks in which no wrapper process is running (manage and heartbeat fire every 5 minutes, scan every 15; a hanging wrapper fails the deploy and restores the running commit), restarts the service, records the new commit in `/var/log/quanttrader/live.sha` at once, and requires: service active; the service's own Node equal to `.nvmrc`; `/login` → 200 (45 attempts, 2 s apart); and the next scheduled manage, heartbeat (`stale_count` 0) and scan ticks each logging `http=200` (up to 25 minutes — the cron wrappers authenticate the routes, so the deploy reads no secret). Only then does it record the commit in `/var/log/quanttrader/running.sha`, write `OK` to `/var/log/quanttrader/deploys.log` and print `DEPLOY_RESULT=OK`; every failure writes a `FAIL` line naming the phase, the step and the commit still running, and after a restart also the restart time and the commit that went live; `live.sha` then names the unverified live commit and the next deploy treats it as the running one. The driver appends a row to `docs/decisions/deploys.md` for every run — OK, FAIL (saying whether the failed commit is live), result unknown after 40 minutes, or interrupted on the workstation (you commit the rows in your next PR), and on OK moves the production pointer `main` to the deployed commit: created on the first deploy, fast-forwarded normally, a leased force-update for a rollback to an ancestor, left alone with a message when the histories diverge. `make status` streams `scripts/ops/status.sh` from `origin/dev` to the host (read-only): service state, the checkout against the verified running commit, the last `http=` line of the scan, manage and heartbeat logs, pending reboot, disk, crontab sizes, plus `origin/dev` for comparison. `make logs LOG=<name> N=<lines>` tails a log. The host targets read `QT_HOST`, `REF`, `LOG`, `N` and `REASON` from the environment inside the recipe and validate them (host alias, ref name, log name, number, one word); no user input is expanded by make into a shell — the one make-expanded text in those recipes is the fixed ssh option string `SSH`, declared `override` so neither a command line nor `MAKEFLAGS` can replace it (`tests/ops/makefile-host-targets.test.ts` pins both). `ops/` holds the host's unit, crontab, sshd drop-in and firewall as code (`ops/README.md` says how each is applied). A deploy takes 10–45 minutes: up to 20 waiting for a tick gap with no wrapper running, up to 25 for the manage, heartbeat and scan ticks after the restart. The driver keeps one multiplexed SSH connection for the whole run (control socket `~/.ssh/qt-deploy-*`, kept 20 minutes): the host's `ufw limit 22/tcp` rejects a source that opens six or more connections in 30 seconds, which cut a driver off on 2026-11-01 while the host run completed detached. If that happens, `make deploy-pointer` reads the host's verified running commit (it refuses unless `running.sha` equals `live.sha`, so a deploy in flight or failed after its restart never moves `main`) and moves `main` to it, with its own ledger row; the deploy row is then written by hand from the host's `deploys.log`. `make status`, `make logs`, `make kill-switch`, `make resume` and `make unpause` share a second multiplexed connection (`~/.ssh/qt-make-*`, kept 60 seconds after the last command; a dead connection is declared within 30 seconds), because the same limit interrupted the D.4 runbook on 2026-11-01. A stale socket (the workstation slept while the master was alive) makes the next target stall for about 30–45 seconds and exit 255 with a `mux_client` error: `ssh -O exit -o ControlPath=~/.ssh/qt-make-%C qt` ends the stale master at once (or delete `~/.ssh/qt-make-*`), then run it again. By hand, a plain `ssh qt …` is its own connection unless it passes the same `ControlPath`; to share the make targets' connection give `Host qt` in `~/.ssh/config` the lines `ControlMaster auto`, `ControlPath ~/.ssh/qt-make-%C` and `ControlPersist 60`, or pass those three `-o` options on each command.

**Why:** before D.1 the host was deployed by hand as root with no record and no check that the service came back, `node_modules` on the host dated from two months before the checkout, and `main` did not exist on the remote. The audit needs deploy dates to bracket paper results, and the operator required the rollback to be one written-down command before the first deploy (decision 0005). The fresh-context review of PR #309 (2026-10-31) added the lock, the detached run, the restore on a failed build, the running-commit record, the tick-gap check for running wrappers, the three verified ticks, the reviewed-scripts check and the environment-read make variables.

**Commands:**

```bash
make status                                  # what runs, verified running commit, last ticks, pending reboot (prompts in a Claude session)
make deploy                                  # origin/dev → VPS, verified, then main moves (prompts; only when the operator asked for a deploy)
make deploy REF=<previous sha>               # rollback: the prev= of the last OK line in `make logs LOG=deploys N=3`; its .nvmrc must match the host's Node (today that prev is 499a8a0 on Node 25 and is refused: a Node-26 rollback target exists once a second Node-26 deploy has been verified)
make deploy-pointer                          # after a driver was cut off: move main to the host's verified running commit (running.sha = live.sha)
make logs LOG=deploys N=10                   # the host's own deploy ledger
make logs LOG=deploy-20261031T140000Z N=60   # one run's full log (the stamp is printed when the run starts)
ssh qt 'sudo -n reboot'; sleep 60; make status   # a reboot: ledger row + decision entry, outside market hours
```

**Raw host commands prompt** (DEBT D-37, operator decision 2026-11-10). `ssh`, `scp`, `sftp` and `rsync` are `ask` rules in `.claude/settings.json`, like the host `make` targets. Before 2026-11-10, auto mode's classifier approved them with no prompt, among them a reboot, a package install and a crontab install. Claude Code's docs say an explicit ask rule prompts in every mode, `bypassPermissions` included. They also say a Bash rule matches the command as written, after compound commands are split and wrappers stripped, not `/usr/bin/ssh` or `sh -c '…'`, and they name the sandbox as the control that does not depend on text (read 2026-11-10).

**The Bash guard's rule 8 holds host commands to one spelling the ask rules match.** It is a text check, best-effort against the plain and accidental forms. A deliberate spelling can still get past it (D-22), and its two review rounds kept finding them:

- **Run bare.** `ssh`, `scp`, `sftp` or `rsync`, lower case and unquoted, is the first word of its own command (after `cd … &&`, or after or before a pipe, is fine). It reaches the `qt` alias, with no `user@`; ssh's host is read after the last `@`. Its arguments hold no `$` or backtick outside single quotes; ssh's hold no unquoted glob where the host or an option is read, and scp's and rsync's none at all, since a local glob can expand to a `host:path`. Only short-listed options are allowed, and ssh's are read before and after the host, as OpenSSH reads them:
  - ssh flags `-4 -6 -C -G -N -n -q -t -T -v -x`;
  - the Makefile's connection-sharing `-o` options (`ControlMaster`, `ControlPath=~/.ssh/qt-…`, `ControlPersist`, `BatchMode`, `ConnectTimeout`, `ServerAliveInterval`, `ServerAliveCountMax`);
  - `-O exit|check|stop`;
  - `-L <port>:localhost|127.0.0.1:<port>`;
  - sftp's `-4 -6 -C -q -v`;
  - scp's `-3 -4 -6 -B -C -O -p -q -r -v`;
  - rsync without `-e`/`--rsh` or a daemon form.

  So `ssh qt '…'`, `ssh qt 'bash -s' < file`, `scp … qt:/tmp/`, `rsync -a qt:… ./`, the kill switch's `ssh -O exit -o ControlPath=~/.ssh/qt-make-%C qt` and the UI's `ssh -L 3000:localhost:3000 qt` all pass, then prompt. The bare word alone passes too: it prints usage and reaches nothing. A canonical `scp` or `rsync` to a local `~/.ssh` path passes this check too, and prompts. A test runs through the guard every line of a `bash` block in the runbooks and this file that starts with `ssh`, `scp`, `sftp` or `rsync` and names `qt`, with its trailing comment dropped. The deploy driver, which `make deploy` runs and which reaches the host itself, has its own ask rule, `Bash(*deploy-driver*)`; a harmless `echo deploy-driver-probe` prompted under it in an auto-mode session on 2026-11-11.
- **Everything else that names a host word is refused.** A host word is `ssh`, `slogin`, `scp`, `sftp`, `rsync`, `ssh-keyscan` or an ssh variant, found after quotes and backslashes are removed and case is folded. That covers:
  - spellings: `'ssh'`, `s\sh`, `SSH`, `./ssh`, `/usr/bin/ssh`, `=ssh`, `c=ssh`, `printf -v c ssh`, `{ssh,…}`;
  - wrappers in front: `sudo`, `env`, `nice`, `command -p`, `xargs`, `find -exec`, `script`, `ssh-agent`;
  - runners: `bash -c`, `csh -c`, `eval`, `osascript`;
  - `$(…)`, `=(…)` and backticks.

  The exception is a command that only reads or prints the word: `grep`, `egrep`, `fgrep`, `rg` (not `--pre`), `ag`, `echo`, `printf` (not `-v`), `man` (not `-P`), `cat`, `ls`, `head`, `tail`, `wc`, `file`, `stat`, `jq`, `shellcheck`, `which`, `whereis`, `type`, `command -v`, and git's `commit|log|show|diff|blame|status|add` (after its global options).
- **Also refused:**
  - a command word built from a substitution, from a variable or escape in its name (not `$` and a digit), or from a glob with a letter in it that matches a host word (`s?h`, `ss$()h`, `$'\x73sh'`, `$c`);
  - zsh glob qualifiers that run code;
  - a shell or interpreter inside `$(…)`, `<(…)` or `>(…)` in a command that names a host word (`… | tee >(bash)`);
  - after a command that names a host word, anything in its pipeline (`|` or `|&`) but a reader (`grep`, `rg`, `head`, `tail`, `cut`, `sort`, `uniq`, `wc`, `tr`, `column`, `cat`, `less`, `more`, `jq`, `nl`, `fold`, `diff`, `cmp`, `shasum`, `sha256sum`, `md5`, `tee`, `od`, `xxd`, `hexdump`, `strings`), and a heredoc or here-string fed to a non-reader;
  - a host word on a continuation line, a backslash-newline after an ssh, and an scp, sftp or rsync continued over lines;
  - any mention of `RSYNC_RSH`, `RSYNC_CONNECT_PROG` or `GIT_SSH*` outside a reader;
  - git, read with its global options dropped, with `core.sshCommand`, `insteadOf`, `receivepack`, `uploadpack`, `--receive-pack` or `--upload-pack` on any non-local subcommand or in a `-c` value (with a `-c` `url=`/`pushurl` too), and `--exec` on push, fetch, pull, clone, ls-remote or archive;
  - git reaching `user@host:`, a non-https URL, or `host:path` (in the repository position for push, fetch and pull);
  - any command naming `~/.ssh` that is not a reader (`ls`, `cat`, `grep`, `stat`, `ssh-keygen -l|-F`); `rm ~/.ssh/qt-make-*` is the exception;
  - shell writes to `.git/config`.

**Known false positives, kept closed:**

- The splitter cannot tell a heredoc's text from commands, so a heredoc line that names a host word is refused unless it starts with a reader. Write such text with the file tools.
- An assignment whose quoted value has a space (`MSG='fix: ssh rule'`) reads as a command.
- A colon in a local scp or rsync path reads as a host.
- A trailing `# comment` is read as part of the command.
- `gh … --body '…ssh…'`, `sed -n '/ssh/p'`, `pnpm exec vitest run -t ssh` and `chmod`/`shellcheck` on a fixture named `ssh` are refused. Use `--body-file`, a reader, or `make lint-shell`.
- A backticked `` `$VAR` `` in a heredoc reads as a command named by a variable.

**Not caught** (D-22):

- a file the command runs (`bash x.sh` whose text names `ssh`);
- a program that opens the connection itself (an interpreter's socket);
- a host command spelled in ways the reviews have not tried;
- `git fetch|pull|push` given an option's value before a user-less `host:path`;
- edits to `~/.ssh` through Claude's own file tools, which `guard-paths` does not see outside the project; `.git/config` is on Claude Code's documented protected-path list, not tested here;
- an `RSYNC_RSH` exported by the user's shell profile;
- **any command the guard takes longer than its 10 s timeout to read.** Each segment costs about 0.35 s, so the limit falls at about 25–30 lines, depending on the machine; the `dev` guard before this change took 10.35 s on a 30-line heredoc (measured 2026-11-10). A timed-out hook lets the call through unless it sets `"onFailure": "block"` (D-22).

The structural control is the sandbox: Claude Code's docs say plain ssh cannot connect from a sandboxed command at all. Turning it on is an operator decision, D-22.

**Live check,** 2026-11-10 21:03–21:05Z, in an auto-mode session (Claude Code 2.1.308), none of it reaching the host:

- These each prompted, with permission record `user_temporary` from `rule:projectSettings`: `ssh -G qt` alone, after `cd … &&`, and fed by a pipe; a local-to-local `scp`; and `rsync --version`.
- The guard refused `FOO=1 ssh -G qt` before any prompt.
- Not checked live: `sftp`, a remote operand, the `||`, `&` and newline separators, and the other permission modes, `bypassPermissions` among them.
- Re-run these after a Claude Code upgrade.

The cases are `tests/hooks/host-cases.ts`. `tests/ops/raw-host-commands.test.ts` keeps the four ask rules in place, with no allow rule matching any shape the guard allows.

**Rules:** no VPS change during market hours (Sunday 22:00 to Friday 22:00 UK) except the kill switch (D.3) and appending the one `HEARTBEAT_PING_URL` line to the host's env file (operator decision 2026-11-02, decision 0009 amendment: an append, never an edit; read on the next tick, no restart, its failure mode is a missing ping; ledger row when done; procedure in `docs/runbooks/d4-alerts-and-rotation.md`). Every deploy attempt leaves its ledger row; every other host change (reboot, package, config) gets a ledger row and, when it changes behaviour, a `docs/decisions/` entry. `main` is never pushed by hand. A change to anything under `ops/` or `scripts/ops/` is a PR about the host, reviewed in a fresh context; they are not fenced (decision 0006), and the driver runs only what `origin/dev` has. After a failed deploy, read the row: a failure before the checkout changed nothing; a failure before the restart restored the running commit on disk (the row says "restored") unless it says `RESTORE FAILED`, in which case the running process has no build on disk and `make deploy REF=<PREVIOUS_SHA>` is the next command; a failure after the restart means the new build is live and broken — run `make deploy REF=<PREVIOUS_SHA>` first, then look for the cause. A run interrupted on the workstation that the host later verifies leaves `main` behind; `make deploy-pointer` moves it to the host's verified running commit. Never restart the service by hand to "finish" a deploy.

## 18. Kill switch, resume, un-pause — one command each

**What:** `make kill-switch REASON=<word>` runs `scripts/ops/kill-switch.sh` on the host as `ops`, streamed from the workstation's **local** copy of `origin/dev` over one ssh connection (no fetch, so it works while GitHub is unreachable). It saves and removes the crontab first (no new ticks), pauses every active algorithm (Supabase REST, service role read on the host; the ids are saved), flattens their open positions through the app's `/api/admin/flatten-algo` route on loopback (paper rows and the broker side of any position with a `broker_position_id`), stops and disables the service, counts what is still open, sends an urgent ntfy push and writes a `KILL …` ledger line whose fields say what actually happened. Every step is attempted even after a failure: with the database or the app unreachable the pause, flatten and count report failures and the crontab removal, the stop, the alert and the ledger line still happen; the run ignores a dropped ssh session; the exit status is non-zero on any failure. It is idempotent and the only host command allowed in market hours (the one other exception: appending the `HEARTBEAT_PING_URL` line, §17). `make resume` enables and starts the service, refuses to restore the crontab while any algorithm is still active, restores it otherwise, waits for the next manage, heartbeat and scan ticks to log 200, pushes and writes `RESUME …`; algorithms stay paused. `make unpause` re-activates exactly the algorithms the switch paused and writes `UNPAUSE …`; it is the operator's deliberate act. Full procedure, paper-test checklist and the dead-man interaction: `docs/runbooks/kill-switch.md`; decision 0008.

**Why:** DEBT D-19 — there was no single stop; pausing orphaned open positions, stopping the service left the crons failing noisily, and nothing recorded what was done. The operator required fail-closed behaviour, an alert, a ledger row and a documented resume.

**Commands:**

```bash
make kill-switch REASON=paper-test       # stop everything; KILL line + urgent push
make status                              # service inactive, crontab 0 entries
make resume                              # service + crons back, ticks verified; algorithms still paused
make unpause                             # trading restarts: exactly the algorithms the switch paused
make logs LOG=deploys N=5                # KILL / RESUME / UNPAUSE lines
```

**Rules:** the switch is the one command excepted from "no VPS change in market hours" (the one other exception is appending the `HEARTBEAT_PING_URL` line, §17). The three targets write `algorithms.status`; `make kill-switch` can also reach the broker through the flatten route, and once mirroring is on `make resume` and `make unpause` count as acting on the broker account too, because together they let the engine trade again — "acting" means placing, modifying or closing orders or changing account settings; read-only broker access from a session is allowed (decision 0010). All three print the mirroring state; that is a record, not a safeguard, because it appears after you approve. They are the only way a Claude session writes to the live tables (`CLAUDE.md`, amended by the operator on 2026-11-01 rather than denying them — decision 0010): each prompts every time, is never pre-approved, runs only when the operator asks for it, and writes its ledger line. "Prompts every time, never pre-approved" is enforced in four layers, the third being the real backstop: `ask` rules in `.claude/settings.json` for both spellings of each host target and for every flagged `make -…`; the Makefile refuses a host goal beside any other goal, or a `MAKECMDGOALS` set from outside make, while it reads the file (`make lint-strict FILES=x unpause` would otherwise match the pre-approved `make lint-strict *` and run the un-pause with no prompt); no pre-approved make rule takes arguments (a wildcard such as `make lint-strict *` would have carried `'--eval=lint-strict: unpause'` past every other check: the un-pause runs as a prerequisite); `guard-bash` refuses a host goal beside another goal, behind a flag or behind an override, and the `-f`/`--eval`/`MAKEFILES=`/`MAKEFLAGS=`/stdin-makefile spellings it can see through (quotes, backslashes, env prefixes) — a text classifier, so the real backstop is the no-arguments rule: every make command with arguments prompts, whatever its spelling, and the Makefile's check covers goals only, never a prerequisite injected by `--eval`. `tests/ops/makefile-host-targets.test.ts` fails if an allow rule in `.claude/settings.json` — or in `.claude/settings.local.json` on a local run; CI never sees that file — is a blanket Bash or make rule, a flag form, names a host target anywhere, or has a wildcard prefix that could grow into one; if any make allow rule, committed, in a skill or local, takes arguments; and if make accepts a host goal beside another. Outside it: user-level settings, `--allowedTools`, and a pre-approved program that runs make for you (`pnpm dlx …`) — the operator prunes those. "Ledger line" is the line the script appends to the host's `deploys.log`; the row in `docs/decisions/deploys.md` is copied from it in the next PR, and `CLAUDE.md`'s "ledger row" means that pair. A failed append to the ledger is an error in all three, and an un-pause whose PATCH failed writes `UNPAUSE result=unknown`. `tests/ops/kill-switch-scripts.test.ts`, `kill-switch-failures.test.ts` and `resume-unpause-scripts.test.ts` run the real scripts against a fake host (`tests/ops/fixtures/fake-host/`: stand-ins for curl, crontab, systemctl, sudo, python3 and id, and a flatten route that closes rows as the real one does); one test reads the route's status strings from `flatten.ts`. They need no network and touch nothing outside a temporary directory. Resume never un-pauses. `make deploy` refuses while the switch is engaged. The targets refuse when the local `origin/dev` does not hold the scripts: `git fetch origin` first.

## 19. Alerts from the host, log rotation, the nightly gate

**What:** three pushes from the host itself through the ntfy topic the dead-man workflow already uses (`NTFY_TOPIC` in the host's `.env.local`, read by the scripts, never printed): `quanttrader.service` has `SuccessExitStatus=143` (Next exits 143 on SIGTERM; without it every deliberate stop ended the unit `failed`) and `ExecStopPost=/usr/local/lib/quanttrader/notify-failure.sh`, a hook systemd runs after every stop that posts an urgent message only when the stop was not clean (`SERVICE_RESULT`), at most one per 10 minutes, so a crash loop under `Restart=always` reaches the phone while deploys and the kill switch stay silent; `scripts/ops/deploy.sh` posts the result of every run (default priority on OK, urgent on FAIL, after the restore); `/usr/local/lib/quanttrader/ops-health.sh` runs from the `ops` crontab at 07:05 UTC and posts one daily summary (service, crons, live vs verified commit and commits behind `origin/dev`, Node, disk, memory, pending reboot, failed units, algorithms held paused by the kill switch, last ledger line), at high priority only when something needs a hand; it also prunes per-run deploy logs older than 30 days. `ops/logrotate/quanttrader` rotates the thirteen cron and ops logs weekly, eight rotations, owned by `ops`, and never touches `deploys.log`. `.github/workflows/nightly.yml` runs CI's exact gate plus `make backtest` on `dev`, scheduled 03:17 UTC, started around 10:45 UTC so far, and pushes on failure. The two host scripts are installed to `/usr/local/lib/quanttrader/` so a rollback cannot remove them; applying: `docs/runbooks/d4-alerts-and-rotation.md`; decision 0009.

**Why:** alerting covered liveness only and only through GitHub Actions (DEBT D-19); a failed unit, a failed deploy or a full disk told nobody, and the logs had never been rotated.

**Commands:**

```bash
make logs LOG=ops-health N=2                 # yesterday's summary as the host saw it
make logs LOG=deploys N=3                    # the ledger lines the pushes summarise
gh workflow run nightly.yml --ref dev        # run the nightly gate now
```

**Rules:** the ntfy topic is a secret (anyone holding it reads the pushes); it lives in the host's env file, the repo's GitHub secrets and the healthchecks.io integration, never in the repo. A new push source is a PR with a row in this section; `backup.sh` is the fourth, from D.6 (§20). The workstation's Claude Code hook (§16) is the fifth: it reads its own copy of the topic from `~/.config/quanttrader/ntfy-topic`, so if that is the host's topic, a rotation updates that file too. When `notify-failure.sh` or `ops-health.sh` change, the runbook's `install` line is repeated: the host runs the installed copies. `HEARTBEAT_PING_URL` is set since 2026-11-06: healthchecks.io is the operator's account and watches the heartbeat ping. The operator reported the check created with its ntfy integration on (2026-11-02), so that account holds the topic too; no down event has exercised that path yet.

## 20. Backups to the Storage Box, and the restore drill

**What:** `scripts/ops/backup.sh` runs nightly at 02:22 UTC from `/usr/local/lib/quanttrader/` as `ops`. It writes five age-encrypted files to `nightly/<date>/` on the Storage Box sub-account `u708205-sub1`: a dump of schema `public`, a data-only dump of `auth.users` and `auth.identities`, the host's env file, its config and the logs. The pinned corpora go to `pins/`. A failed part is not uploaded, and an `OK` file goes up last on a whole night only. It keeps 30 nights, prunes only after a fully verified night, and pushes urgently on any failure. It reads the database as `backup_ro`, a role that can read everything and write nothing, over TLS with `PGSSLMODE=verify-full` against Supabase's root CA (`ops/backup/prod-ca-2021.crt`, installed as `/usr/local/lib/quanttrader/supabase-prod-ca-2021.crt`; from the 14–15 November window, `require` before it). Without that file, or if Supabase changes its certificate chain or the root expires (2031-04-26), every dump fails and pushes until a new certificate is installed. The daily summary shows `backup=<time>` and turns high priority if the last good night is older than 26 hours. Supabase's own backups are the first line: Pro plan, daily, 7-day retention, no point-in-time recovery. The private age key is the operator's and is never on the host, the box or in a session.

**Why:** the approval of 2026-10-31 asked for it, Supabase's 7 days sit with the same provider as the data, and `oanda_positioning_cache` is forward-only, so it cannot be fetched again. Decision 0011.

**Commands:**

```bash
make logs LOG=backup N=20      # last night's run
pnpm exec vitest run tests/ops/backup-script.test.ts   # the script against stand-ins
```

**Rules:** a change to `backup.sh` or `ops-health.sh` repeats the runbook's `install` line, because the host runs the installed copies. The restore drill in `docs/runbooks/d6-backups.md` runs twice a year and before any schema change. A decrypted dump holds broker tokens and password hashes and never enters a session.
