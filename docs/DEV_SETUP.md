# DEV_SETUP — the tooling around the code

One short section per thing that was set up: **what it is, why it exists, the one command to use it.** Kept current in the same PR as the thing it describes. Sections are added as the Phase B PRs land; the command cheat-sheet in §1 is the only part you need day to day.

## 1. Cheat-sheet

| I want to… | Command | Added in |
|---|---|---|
| see every check | `make help` | B3 |
| run everything CI runs | `make check` (lint + lint-shell + typecheck + test) | B3 |
| lint / type-check / test | `make lint` · `make typecheck` · `make test` | B3 |
| format what I changed | `make format` (then `make format-check`) | B3 |
| hold a new file to the target rules | `make lint-strict FILES=path/to/new-file.ts` | B3 |
| set up the Python sidecar | `make python-env` | B2/B3 |
| rotate the cron secret | `docs/runbooks/rotate-cron-secret.md` (manual, ~5 min) | B1 |
| harden the VPS (**Critical**: password auth is on) | `docs/runbooks/harden-vps-ssh.md` (manual, ~10 min today) | B1 |

Stubs that exit 2 with a message until their PR lands: `make backtest` (golden file, B10), `make validate` / `make parity` (audit scripts, when they reach `dev`), `make db-types` / `make db-types-check` (B7).

## 2. Secrets — where they live and the rules

- **Local:** `.env.local` at the repo root (gitignored by `.env*`). Never committed, never read by tooling or by Claude Code sessions; only the cron wrappers grep single names out of it.
- **VPS:** `/opt/quanttrader/.env.local` (0600, root). The app loads it at start; a restart is required after any change.
- **GitHub Actions:** repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NTFY_TOPIC`, `NTFY_TOKEN` (dead-man workflow only; CI needs none).
- **`.env.example` is the index:** every variable the code reads appears there by name with a one-line purpose, values never. Adding a `process.env.X` read means adding `X` to `.env.example` in the same PR (a CI check for this arrives with the CI PR).
- **Rotation:** `docs/runbooks/rotate-cron-secret.md`. Rotate `CRON_SECRET` now — the 2026-10-28 inventory found its value in a local Claude Code allow-rule (deleted the same day; it was never committed: `git log --all -- .claude/settings.local.json` is empty).
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

`docs/runbooks/` holds operator procedures with exact commands and a verification checklist each. Current: `rotate-cron-secret.md`, `harden-vps-ssh.md` (**Critical**). Phase D adds deploy, kill-switch, backup/restore.

## 5. Environments — Node, pnpm, Python

**What:** `.nvmrc` pins Node `25.9.0` (what the VPS runs under systemd); `package.json` `engines` says `node >=25.9.0 <26`, `pnpm >=10`; `pnpm-lock.yaml` is committed and installs use `--frozen-lockfile` (local, CI, VPS). The Python research sidecar is pinned by `scripts/python/pyproject.toml` + `uv.lock` (`requires-python >=3.11,<3.14`; `requirements.txt` is exported from the lock for pip users).

**Why:** three different Node versions were in play (local 25.3, VPS 25.9, `@types/node` 20) and the sidecar had loose `>=` pins with no lock, so "works on my machine" was the only guarantee. Node 25 is not an LTS line; moving production to the current LTS is a Phase D decision, not a tooling one.

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
- **Baseline** (`eslint.config.mjs`, `tsconfig.json`): the rules the code passes today. `make lint` fails on any error and on more warnings than `.eslint-warning-budget` (174 on 2026-10-28: 117 in `src/`, 57 in live-path scripts). The budget is a ratchet: it may only go down, and a PR that lowers it edits the file.
- **Target** (`eslint.config.strict.mjs`): `typescript-eslint` strict + stylistic type-checked rules, `complexity ≤ 10`, 80-line functions, 300-line files, `no-console` (scripts excepted), no `any`, no object-literal casts, explicit module boundary types, no floating promises, no empty catch, ordered acyclic imports. Every **new** file is held to it from its first PR (pre-commit and CI run it on added files); existing files migrate one PR at a time after the audit verdict and never go back. Settings are never loosened.
- **Types:** `make typecheck` runs `tsc --noEmit` over `src/`, `tests/` and `scripts/` **including test files**. It goes green with PR B5 (155 type errors in test files, type-only fixes, assertions unchanged).
- **Format:** Prettier on changed files only (`make format`, pre-commit). The whole-tree format is one dedicated PR after the audit verdict, with its hash in `.git-blame-ignore-revs`. `make format-all-check` shows the current whole-tree state (informational).
- **Shell:** `make lint-shell` = `shellcheck -S error` on the cron wrappers (0 errors today); target is `-S warning` (6 `SC2155` "declare and assign separately" warnings, DEBT.md).

**Why:** CI has to exist today, so it starts at the level the code passes; new code must not add to the debt, so it starts at the target. The two configs make that split explicit instead of a convention nobody checks.

## 8. `scripts/` — what is checked and what is not

**What:** `scripts/dev/checked-scripts.mjs` is the single list. Everything under `scripts/` is **live-path** and checked like `src/` (ESLint baseline, tsc, Prettier) **except** the 42 research one-offs it names (`e2.*`, `verify-*`, `robustness-*`, stress runs, feature/label experiments, search drivers), which ESLint skips. `scripts/archive/` and run caches are never checked. `node scripts/dev/checked-scripts.mjs` prints the live-path file list for tools that cannot import it.

**Why:** 46k lines were excluded from every check, including the deploy scripts, the cron wrappers' TypeScript and the verdict/baseline scripts that produced the live rules. Research scripts are excluded by name, not by directory, so moving nothing (renames wait for the audit) still lets the live-path scripts be checked. Each research script has a target date in `docs/DEBT.md` D-20 (2027-01-31) to be brought under the checks or archived; adding a script to the research list needs a DEBT.md line.

## 9. Pre-commit — what runs before every commit

**What:** `.husky/pre-commit` (installed by `pnpm install` through the `prepare` script, which sets `core.hooksPath=.husky`). On every `git commit` it runs, in order:

1. **gitleaks** on the staged changes (`gitleaks git --pre-commit --staged`) — a secret-shaped string stops the commit. The hook refuses to run at all if gitleaks is missing (`brew install gitleaks`); it never silently skips.
2. **lint-staged** (`.lintstagedrc.mjs`): Prettier writes every staged code file; ESLint baseline runs on staged TS/JS (errors fail); the **target** config runs on files that are new in the commit; shellcheck runs on staged cron wrappers.

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
